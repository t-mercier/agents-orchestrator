//! Terminal launching helpers for running commands in the user's chosen terminal.
//! macOS: iTerm2 / Terminal.app adapters (osascript) with window-reveal support.
//! Linux: an auto-detected terminal emulator; window reveal is unsupported.
//! Both expose the same `pub(crate)` API: `launch_in_terminal`, `session_tty`,
//! `scan_terminals`.

use crate::config;

/// Run a shell command in a new iTerm2 tab. The command is delivered to osascript
/// as an `on run argv` argument — never interpolated into the AppleScript body —
/// so there is no AppleScript/shell injection (mirrors the Electron ADR-005 shape).
/// Callers must shell-quote any values interpolated into `cmd`.
#[cfg(target_os = "macos")]
fn run_in_iterm_tab(cmd: &str) -> Result<(), String> {
    std::process::Command::new("osascript")
        .args([
            "-e", "on run argv",
            "-e", "set cmd to item 1 of argv",
            "-e", "tell application \"iTerm2\"",
            "-e", "activate",
            "-e", "if (count of windows) = 0 then create window with default profile",
            "-e", "set newTab to (create tab with default profile in current window)",
            "-e", "tell current session of newTab to write text cmd",
            "-e", "end tell",
            "-e", "end run",
        ])
        .arg(cmd)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Run a shell command in a new Terminal.app window. Same `on run argv` shape as
/// the iTerm adapter — the command is an argv arg, never interpolated into the
/// AppleScript body, so no injection. Terminal.app is always present on macOS,
/// so this is the bulletproof fallback.
#[cfg(target_os = "macos")]
fn run_in_terminal_app(cmd: &str) -> Result<(), String> {
    std::process::Command::new("osascript")
        .args([
            "-e", "on run argv",
            "-e", "tell application \"Terminal\"",
            "-e", "activate",
            "-e", "do script (item 1 of argv)",
            "-e", "end tell",
            "-e", "end run",
        ])
        .arg(cmd)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Launch `cmd` in the user's chosen terminal. The selector comes from
/// config.terminalApp and is matched against a strict allowlist (the config JSON
/// is hand-editable, so it's never trusted as more than a selector). Blank or
/// unknown → default: iTerm if installed, else Terminal.app. The command itself
/// is unchanged — already validated + shell-quoted by the caller.
#[cfg(target_os = "macos")]
pub(crate) fn launch_in_terminal(cmd: &str) -> Result<(), String> {
    let sel = config::load()
        .get("terminalApp")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    match sel.as_str() {
        "iterm" => run_in_iterm_tab(cmd),
        "terminal" => run_in_terminal_app(cmd),
        // system default / unknown / blank
        _ if std::path::Path::new("/Applications/iTerm.app").exists() => run_in_iterm_tab(cmd),
        _ => run_in_terminal_app(cmd),
    }
}

/// The controlling tty of a pid (e.g. "/dev/ttys003"), via `ps`. None when the
/// process has no terminal tty — e.g. it runs in our embedded pty rather than a
/// real terminal window (so there's nothing to reveal).
#[cfg(target_os = "macos")]
pub(crate) fn session_tty(pid: i64) -> Option<String> {
    if pid <= 0 {
        return None;
    }
    let out = std::process::Command::new("ps")
        .args(["-o", "tty=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let t = String::from_utf8_lossy(&out.stdout).trim().to_string();
    // ps prints "ttys003", or "??" / "" when there is no controlling terminal.
    if !t.starts_with("ttys") {
        return None;
    }
    Some(format!("/dev/{t}"))
}

/// Find the tab whose tty matches in `app_name` ("iTerm2" | "Terminal"); if
/// `select`, bring it to front. Returns true if found. `tty` is an argv arg (never
/// interpolated into the script body) → no injection. The `is running` guard keeps
/// a mere check from launching the terminal app.
#[cfg(target_os = "macos")]
fn reveal_in(app_name: &str, tty: &str, select: bool) -> bool {
    let script = if app_name == "iTerm2" {
        r#"on run argv
  set tgt to item 1 of argv
  set md to item 2 of argv
  if application "iTerm2" is running then
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if (tty of s) is tgt then
              if md is "select" then
                -- `tell s to select` alone selects the session WITHIN its tab but
                -- does NOT bring its window forward, so `activate` showed whatever
                -- window was current (wrong one). `select w` raises the right
                -- window; then select the tab + the (possibly split-pane) session.
                --
                -- A HOTKEY window is not an ordinary window: it is hidden by iTerm's
                -- hotkey mechanism, and `select w` + `activate` select the tab without
                -- ever un-hiding it (the user sees nothing happen). Those windows only
                -- come back via `reveal hotkey window`. Wrapped in `try` so an older
                -- iTerm lacking the `is hotkey window` property falls back to `select w`
                -- instead of erroring out the whole script.
                set didReveal to false
                try
                  if (is hotkey window of w) then
                    tell w to reveal hotkey window
                    set didReveal to true
                  end if
                end try
                if not didReveal then select w
                tell t to select
                tell s to select
                activate
              end if
              return "1"
            end if
          end repeat
        end repeat
      end repeat
    end tell
  end if
  return "0"
end run"#
    } else {
        r#"on run argv
  set tgt to item 1 of argv
  set md to item 2 of argv
  if application "Terminal" is running then
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          if (tty of t) is tgt then
            if md is "select" then
              set selected of t to true
              set frontmost of w to true
              activate
            end if
            return "1"
          end if
        end repeat
      end repeat
    end tell
  end if
  return "0"
end run"#
    };
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .arg(tty)
        .arg(if select { "select" } else { "check" })
        .output();
    matches!(out, Ok(o) if String::from_utf8_lossy(&o.stdout).trim() == "1")
}

/// Look for the session's window wherever it might be — iTerm (if installed) then
/// Terminal.app — independent of the launch preference. `select` brings it forward.
#[cfg(target_os = "macos")]
pub(crate) fn scan_terminals(tty: &str, select: bool) -> bool {
    if std::path::Path::new("/Applications/iTerm.app").exists() && reveal_in("iTerm2", tty, select) {
        return true;
    }
    reveal_in("Terminal", tty, select)
}

// ── Linux ────────────────────────────────────────────────────────────────────
// Same `pub(crate)` API as the macOS adapters above. Window reveal has no portable
// X11/Wayland equivalent, so `session_tty` returns None and `scan_terminals` is a
// no-op — which makes `can_reveal_terminal` false (the UI never offers the button)
// and `reveal_terminal` error cleanly.

/// Terminals we know how to drive, in auto-detect preference order.
#[cfg(not(target_os = "macos"))]
const KNOWN_TERMINALS: &[&str] = &[
    "gnome-terminal", "konsole", "xfce4-terminal", "kitty", "alacritty", "foot", "xterm",
];

/// Build the argv to run `cmd` in `bin`, keeping the window open after the command
/// exits (`; exec bash`) to match the macOS `do script` behaviour. Each terminal has
/// its own "run this program" flag. `cmd` is passed as a single `bash -lc` argument
/// (never re-interpolated), so the caller's shell-quoting is preserved — no injection.
#[cfg(not(target_os = "macos"))]
fn terminal_argv(bin: &str, cmd: &str) -> Vec<String> {
    let script = format!("{cmd}; exec bash");
    let head: Vec<&str> = match bin {
        "gnome-terminal" => vec![bin, "--"],
        "xfce4-terminal" => vec![bin, "-x"],
        "kitty" | "foot" => vec![bin],
        // konsole, xterm, alacritty, x-terminal-emulator use `-e`. A non-allowlisted
        // $TERMINAL also lands here: `-e` is a best-effort guess for unknown binaries.
        _ => vec![bin, "-e"],
    };
    let mut v: Vec<String> = head.into_iter().map(String::from).collect();
    v.extend(["bash".to_string(), "-lc".to_string(), script]);
    v
}

/// True if `bin` is found on PATH. `bin` is passed as a positional arg to `sh -c`
/// (referenced as `"$1"`), never interpolated into the script body — so an arbitrary
/// `$TERMINAL` value cannot inject shell.
#[cfg(not(target_os = "macos"))]
fn on_path(bin: &str) -> bool {
    std::process::Command::new("sh")
        .args(["-c", r#"command -v "$1" >/dev/null 2>&1"#, "sh", bin])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Pick a terminal: explicit selector (matched against KNOWN_TERMINALS) → $TERMINAL
/// → x-terminal-emulator (Debian alternatives wrapper) → first installed of
/// KNOWN_TERMINALS. None if nothing is found.
#[cfg(not(target_os = "macos"))]
fn resolve_terminal(selector: &str) -> Option<String> {
    let sel = selector.trim();
    if !sel.is_empty() && KNOWN_TERMINALS.contains(&sel) && on_path(sel) {
        return Some(sel.to_string());
    }
    if let Ok(t) = std::env::var("TERMINAL") {
        if !t.is_empty() && on_path(&t) {
            return Some(t);
        }
    }
    if on_path("x-terminal-emulator") {
        return Some("x-terminal-emulator".to_string());
    }
    KNOWN_TERMINALS.iter().find(|b| on_path(b)).map(|b| b.to_string())
}

/// Launch `cmd` in an external terminal emulator. Selector from config.terminalApp
/// (matched against the allowlist); `cmd` is already validated + shell-quoted.
#[cfg(not(target_os = "macos"))]
pub(crate) fn launch_in_terminal(cmd: &str) -> Result<(), String> {
    let sel = config::load()
        .get("terminalApp")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let bin = resolve_terminal(&sel).ok_or_else(|| {
        format!(
            "no supported terminal found (tried selector, $TERMINAL, x-terminal-emulator, {})",
            KNOWN_TERMINALS.join(", ")
        )
    })?;
    let argv = terminal_argv(&bin, cmd);
    std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// No portable way to map a pid to a focusable terminal window on Linux, so reveal
/// is unsupported: returning None makes `can_reveal_terminal` false.
#[cfg(not(target_os = "macos"))]
pub(crate) fn session_tty(_pid: i64) -> Option<String> {
    None
}

/// Reveal is unsupported on Linux (see `session_tty`); always false.
#[cfg(not(target_os = "macos"))]
pub(crate) fn scan_terminals(_tty: &str, _select: bool) -> bool {
    false
}

#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    use super::terminal_argv;

    #[test]
    fn terminal_argv_per_terminal_exec_flags() {
        assert_eq!(terminal_argv("gnome-terminal", "echo hi"),
                   vec!["gnome-terminal", "--", "bash", "-lc", "echo hi; exec bash"]);
        assert_eq!(terminal_argv("konsole", "X"),   vec!["konsole", "-e", "bash", "-lc", "X; exec bash"]);
        assert_eq!(terminal_argv("xterm", "X"),     vec!["xterm", "-e", "bash", "-lc", "X; exec bash"]);
        assert_eq!(terminal_argv("alacritty", "X"), vec!["alacritty", "-e", "bash", "-lc", "X; exec bash"]);
        assert_eq!(terminal_argv("kitty", "X"),     vec!["kitty", "bash", "-lc", "X; exec bash"]);
        assert_eq!(terminal_argv("foot", "X"),      vec!["foot", "bash", "-lc", "X; exec bash"]);
        assert_eq!(terminal_argv("xfce4-terminal", "X"), vec!["xfce4-terminal", "-x", "bash", "-lc", "X; exec bash"]);
    }
}
