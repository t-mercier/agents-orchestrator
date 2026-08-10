//! Embedded terminal backend (port of data/pty-manager.js).
//! One pty per session running `claude --resume <id>`; output is streamed to the
//! renderer via the `pty-data` event, input/resize/kill come back as commands.
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

/// Model passed to `claude --model`. `[1m]` selects the 1M-context variant — it is
/// NOT a glob/regex, so every command embedding this must shell-quote it (otherwise
/// the shell tries to glob-expand the `[…]` and the launch fails).
pub const CLAUDE_MODEL: &str = "opus[1m]";

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Kill every embedded child. Called on app exit so the `claude` processes we
    /// spawned in embedded terminals don't orphan and keep the session "running"
    /// (with no terminal) after the app reopens — they die with the app, then show
    /// up cleanly as `stale` in the Running tab.
    pub fn kill_all(&self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for s in sessions.values_mut() {
                let _ = s.child.kill();
                let _ = s.child.wait(); // reap so none linger as <defunct>
            }
            sessions.clear();
        }
    }
}

/// Wrap a string in single quotes for safe interpolation into a shell command.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Decode one pty read into a String, carrying any incomplete trailing UTF-8
/// sequence (a multibyte char split across read() boundaries) in `carry` for the
/// next call. The pty reader gets fixed 8192-byte chunks; `from_utf8_lossy` per
/// chunk turns a boundary-split box-draw glyph (─ = E2 94 80) or accented char
/// (é = C3 A9) into U+FFFD, which corrupts Claude Code's separator lines and any
/// non-ASCII output in the embedded terminal. Genuinely invalid bytes (not a
/// boundary split) are still replaced, so we never loop forever on garbage.
pub fn decode_chunk(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    let mut bytes = std::mem::take(carry);
    bytes.extend_from_slice(chunk);
    match std::str::from_utf8(&bytes) {
        Ok(s) => s.to_string(),
        Err(e) => {
            let valid = e.valid_up_to();
            // SAFETY: valid_up_to() is, by definition, a valid UTF-8 boundary.
            let mut out = unsafe { std::str::from_utf8_unchecked(&bytes[..valid]) }.to_string();
            match e.error_len() {
                // None = the tail is an incomplete multibyte char → carry it.
                None => *carry = bytes[valid..].to_vec(),
                // Some = genuinely invalid bytes mid-stream → replace, don't carry.
                Some(_) => out.push_str(&String::from_utf8_lossy(&bytes[valid..])),
            }
            out
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // pty knobs: size + the three launch variants
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<PtyManager>,
    session_id: String,
    cwd: String,
    cols: u16,
    rows: u16,
    // When non-empty, restart the session via the /restart-session skill (rebuild from
    // notes) instead of --resume. Used for sessions whose transcript is gone, so
    // --resume can't find the conversation. Validated as a folder-slug.
    restart_slug: String,
    // When non-empty, a full shell command built + validated by start_session(embedded=true)
    // — run verbatim to CREATE a new session in this pty (the embedded +New path). Wins over
    // both branches below. session_id is then the new session's notesPath (the routing key).
    command: String,
) -> Result<(), String> {
    let restart_slug = restart_slug.trim().to_string();
    if !restart_slug.is_empty() && !crate::is_safe_slug(&restart_slug) {
        return Err("invalid slug".into());
    }
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(existing) = sessions.get_mut(&session_id) {
        // A pty whose child already exited (user typed `exit`, or claude quit) still has
        // its entry here: the reader thread emits pty-exit on EOF but can't reach this map.
        // Returning early on a dead entry would block reopen forever (no new pty spawns).
        // try_wait reaps an exited child; if it's gone, drop the stale entry so the spawn
        // below recreates it. A still-running child means we're genuinely already attached.
        match existing.child.try_wait() {
            Ok(Some(_)) => {
                sessions.remove(&session_id);
            }
            _ => return Ok(()),
        }
    }

    // Spawn at the size the renderer already measured, so claude renders at the
    // right width from the first line (it won't reflow earlier output on resize).
    let size = PtySize {
        rows: if rows == 0 { 24 } else { rows },
        cols: if cols == 0 { 80 } else { cols },
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;

    // Resume the session in an INTERACTIVE login shell (so PATH/etc. are set and `claude`
    // is found), from the session's recorded cwd (Claude Code keys --resume by directory).
    // Interactive matters: tools like `claude` are commonly added to PATH in ~/.zshrc
    // (sourced only for interactive shells), not ~/.zprofile. A plain login shell (`-lc`)
    // skips ~/.zshrc, so a Finder-launched app (which inherits only a minimal PATH) then
    // can't find `claude`. `-ilc` sources both, matching a real terminal tab.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let command = command.trim().to_string();
    let inner = if !command.is_empty() {
        // Verbatim command from start_session(embedded=true): `cd <dir> && [git checkout
        // <branch> && ] claude --model X '/start-session …'`. Every interpolation was
        // shell_quote'd in lib.rs, so it's safe to run as-is — same shape as the
        // /restart-session branch, which already runs a slash command in the pty.
        command
    } else if restart_slug.is_empty() {
        // --permission-mode auto: the resumed session must be able to run /close-session
        // and /save-session (which WRITE notes.md and bail in plan mode). Without it a
        // resume in plan mode can never record its close → it lingers as "stale". Matches
        // +New / Import.
        let settings_arg = crate::statusline_settings_arg();
        format!(
            "cd {} && claude --resume {} --model {} --permission-mode auto{}",
            shell_quote(&cwd),
            shell_quote(&session_id),
            shell_quote(CLAUDE_MODEL),
            settings_arg,
        )
    } else {
        // /restart-session rebuilds from notes — no transcript needed. Auto mode so the
        // skill (which writes + re-registers) and a later /close-session aren't blocked.
        let settings_arg = crate::statusline_settings_arg();
        format!(
            "cd {} && claude --model {} --permission-mode auto{} {}",
            shell_quote(&cwd),
            shell_quote(CLAUDE_MODEL),
            settings_arg,
            shell_quote(&format!("/restart-session {restart_slug}")),
        )
    };
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-ilc");
    cmd.arg(&inner);
    for (k, v) in std::env::vars() {
        // Don't leak the HOST terminal's identity into the embedded pty. Launched
        // from iTerm (e.g. `cargo tauri dev`), the app inherits TERM_PROGRAM=iTerm.app
        // + ITERM_*/LC_TERMINAL — which makes the resumed `claude` emit iTerm-
        // proprietary escape sequences (the title-badge) that xterm.js can't parse,
        // so they render as stray on-screen artifacts. Present a plain xterm instead.
        if matches!(
            k.as_str(),
            "TERM_PROGRAM" | "TERM_PROGRAM_VERSION" | "TERM_SESSION_ID"
                | "LC_TERMINAL" | "LC_TERMINAL_VERSION"
        ) || k.starts_with("ITERM")
        {
            continue;
        }
        cmd.env(k, v);
    }
    // xterm.js is an xterm-256color terminal — say so explicitly (rather than
    // inheriting whatever the host advertised).
    cmd.env("TERM", "xterm-256color");
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The child is live from here on — if wiring its I/O fails, kill + reap it
    // before erroring, or it runs unmanaged forever (never in the map, so no
    // pty_kill/kill_all can reach it) and its shell lingers as a zombie.
    let io = pair.master.try_clone_reader().and_then(|r| pair.master.take_writer().map(|w| (r, w)));
    let (mut reader, writer) = match io {
        Ok(rw) => rw,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e.to_string());
        }
    };
    drop(pair.slave); // close our handle to the slave so the child owns it

    // Reader thread → stream output to the renderer; emit pty-exit on EOF.
    let app2 = app.clone();
    let sid = session_id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new(); // incomplete trailing UTF-8 across reads
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = decode_chunk(&mut carry, &buf[..n]);
                    if data.is_empty() {
                        continue; // whole chunk was an incomplete multibyte tail
                    }
                    let _ = app2.emit("pty-data", serde_json::json!({ "sessionId": sid, "data": data }));
                }
            }
        }
        let _ = app2.emit("pty-exit", serde_json::json!({ "sessionId": sid }));
    });

    sessions.insert(session_id, Session { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
pub fn pty_input(state: tauri::State<PtyManager>, session_id: String, data: String) {
    if let Some(s) = state.sessions.lock().unwrap().get_mut(&session_id) {
        let _ = s.writer.write_all(data.as_bytes());
        let _ = s.writer.flush();
    }
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<PtyManager>, session_id: String, cols: u16, rows: u16) {
    if let Some(s) = state.sessions.lock().unwrap().get(&session_id) {
        let _ = s.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<PtyManager>, session_id: String) {
    // Take the session out (releasing the lock at the end of THIS statement — binding
    // to a local avoids holding the mutex across the blocking wait below).
    let session = state.sessions.lock().unwrap().remove(&session_id);
    if let Some(mut s) = session {
        let _ = s.child.kill();
        // kill() only signals; wait() reaps it. Without this the SIGKILL'd shell
        // lingers as a <defunct> zombie until app exit (one per open/close-session).
        let _ = s.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_chunk, shell_quote};

    #[test]
    fn shell_quote_wraps_plain_strings() {
        assert_eq!(shell_quote("abc"), "'abc'");
        assert_eq!(shell_quote(""), "''");
        assert_eq!(shell_quote("/Users/dev/work/FEAT/x"), "'/Users/dev/work/FEAT/x'");
    }

    #[test]
    fn shell_quote_neutralizes_single_quotes() {
        // The single quote is the ONLY char that can break out of a '…' context;
        // it must become the canonical '\'' sequence.
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn shell_quote_leaves_other_metachars_literal() {
        // $, backtick, ", \, ;, &, |, newline are all literal inside single quotes —
        // with no single quote present, the output is just the input wrapped in '…'.
        let s = "a $b `c` \"d\" \\e ; f & g | h\n";
        assert_eq!(shell_quote(s), format!("'{s}'"));
    }

    #[test]
    fn box_draw_split_across_chunks_is_not_corrupted() {
        // ─ (U+2500) = E2 94 80, split after the first byte across two reads.
        let mut carry = Vec::new();
        assert_eq!(decode_chunk(&mut carry, &[0xE2]), ""); // nothing emittable yet
        assert_eq!(carry, vec![0xE2]); // incomplete tail carried
        assert_eq!(decode_chunk(&mut carry, &[0x94, 0x80]), "\u{2500}");
        assert!(carry.is_empty());
    }

    #[test]
    fn accented_char_split_keeps_ascii_then_completes() {
        // "c" + start of é (C3) in one read; A9 in the next.
        let mut carry = Vec::new();
        assert_eq!(decode_chunk(&mut carry, &[0x63, 0xC3]), "c");
        assert_eq!(carry, vec![0xC3]);
        assert_eq!(decode_chunk(&mut carry, &[0xA9]), "\u{e9}"); // é
    }

    #[test]
    fn complete_chunk_passes_through_and_carry_stays_empty() {
        let mut carry = Vec::new();
        assert_eq!(decode_chunk(&mut carry, "check dans".as_bytes()), "check dans");
        assert!(carry.is_empty());
    }

    #[test]
    fn four_byte_emoji_split_across_chunks() {
        // 😀 U+1F600 = F0 9F 98 80, split after the first two bytes.
        let mut carry = Vec::new();
        assert_eq!(decode_chunk(&mut carry, &[0xF0, 0x9F]), ""); // incomplete → nothing yet
        assert_eq!(carry, vec![0xF0, 0x9F]);
        assert_eq!(decode_chunk(&mut carry, &[0x98, 0x80]), "\u{1F600}");
        assert!(carry.is_empty());
    }

    #[test]
    fn invalid_byte_does_not_carry_a_following_incomplete_tail() {
        // 'a', 0xFF (invalid), 0xC3 (start of a 2-byte char, incomplete at EOF).
        // The invalid byte forces a lossy conversion of the whole tail, so the trailing
        // C3 is replaced rather than carried — guarantees no infinite carry/loop.
        let mut carry = Vec::new();
        let out = decode_chunk(&mut carry, &[0x61, 0xFF, 0xC3]);
        assert!(out.starts_with('a'));
        assert_eq!(out.matches('\u{FFFD}').count(), 2);
        assert!(carry.is_empty());
    }

    #[test]
    fn genuinely_invalid_bytes_are_replaced_not_carried() {
        // 0xFF is never valid UTF-8 — must be replaced, never carried (no infinite loop).
        let mut carry = Vec::new();
        let out = decode_chunk(&mut carry, &[0x61, 0xFF, 0x62]);
        assert!(carry.is_empty());
        assert!(out.starts_with('a') && out.ends_with('b'));
        assert!(out.contains('\u{FFFD}'));
    }
}
