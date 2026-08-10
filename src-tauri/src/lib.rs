mod config;
mod pty;
mod reader;
mod git;
mod terminal;
mod skills;
mod statusline;

use tauri::{Manager, Emitter};
use serde_json::Value;

/// Build a `--settings '<path>'` argument (with leading space) that injects the
/// statusLine wrapper, or return an empty string if settings file writing fails.
/// Writes a per-session launch-settings.json to ~/.config/ai-agents-orchestrator/
/// that injects ao-statusline.sh as the statusLine, preserving the user's own
/// statusline command (read read-only from ~/.claude/settings.json).
/// Any error (can't write settings, can't read user config) returns "", so the
/// launch proceeds without injection.
pub(crate) fn statusline_settings_arg() -> String {
    let config_dir = config::home().join(".config").join("ai-agents-orchestrator");
    if std::fs::create_dir_all(&config_dir).is_err() {
        return String::new();
    }

    // Read the user's current statusLine command (if any) from ~/.claude/settings.json.
    let user_statusline = {
        let settings_path = config::home().join(".claude").join("settings.json");
        match std::fs::read_to_string(&settings_path) {
            Ok(content) => {
                if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&content) {
                    if let Some(statusline) = map.get("statusLine") {
                        if let Some(cmd) = statusline.get("command").and_then(Value::as_str) {
                            cmd.to_string()
                        } else {
                            String::new()
                        }
                    } else {
                        String::new()
                    }
                } else {
                    String::new()
                }
            }
            Err(_) => String::new(),
        }
    };

    // Build the wrapper command: ao-statusline.sh with the user's original as an arg.
    let ao_statusline = config::home().join(".claude").join("ao-statusline.sh");
    let wrapper_cmd = format!(
        "{} {}",
        ao_statusline.to_string_lossy(),
        pty::shell_quote(&user_statusline)
    );

    // Build the settings JSON: inject the wrapper as the statusLine.
    let settings = serde_json::json!({
        "statusLine": {
            "type": "command",
            "command": wrapper_cmd
        }
    });

    let settings_file = config_dir.join("launch-settings.json");
    let settings_json = match serde_json::to_string(&settings) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };

    if atomic_write(&settings_file, &settings_json).is_err() {
        return String::new();
    }

    format!(" --settings '{}'", settings_file.to_string_lossy())
}

/// Open an http(s) URL in the system browser. The scheme check already prevents a
/// leading `-`; `--` terminates `open`'s option parsing (defense-in-depth).
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    // http(s) only. The URI comes from terminal output — untrusted text — and reaches the
    // OS opener, so `file://` is deliberately NOT allowed: a single click on a printed
    // `file:///…/x.app` would launch it (local code execution). Opening a local path stays
    // behind open_path, which canonicalizes it first.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("unsupported URL scheme: {url}"));
    }
    std::process::Command::new(OPEN_CMD)
        .arg("--")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The OS "open this URL/path in the default handler" command: `open` on macOS,
/// `xdg-open` elsewhere. Both accept `--` to terminate option parsing.
#[cfg(target_os = "macos")]
const OPEN_CMD: &str = "open";
#[cfg(not(target_os = "macos"))]
const OPEN_CMD: &str = "xdg-open";

/// Reveal a path (e.g. a session folder) in Finder. Reject leading-dash paths
/// (argv flag smuggling), canonicalize to an absolute path, and pass `--` so a
/// crafted path can never be parsed as an `open` flag.
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if path.starts_with('-') {
        return Err("invalid path".into());
    }
    let abs = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    std::process::Command::new(OPEN_CMD)
        .arg("--")
        .arg(&abs)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}


/// Can we reveal an existing terminal window for this session? (Used to decide
/// whether to OFFER the "Reveal window" button.) Check-only: no focus change, and
/// the `is running` guard means it won't launch a terminal.
#[tauri::command(async)]
fn can_reveal_terminal(pid: i64) -> bool {
    match terminal::session_tty(pid) {
        Some(tty) => terminal::scan_terminals(&tty, false),
        None => false,
    }
}

/// Bring the session's existing terminal window/tab to the front (instead of
/// opening a second instance). Errors if it can't be found.
#[tauri::command(async)]
fn reveal_terminal(pid: i64) -> Result<(), String> {
    let tty = terminal::session_tty(pid).ok_or("session has no terminal tty")?;
    if terminal::scan_terminals(&tty, true) {
        Ok(())
    } else {
        Err("couldn't find that terminal window".into())
    }
}

/// Strict category token — the real injection boundary, since the config JSON is
/// hand-editable and bypasses config.validate(). Mirrors the Electron SAFE_CATEGORY.
fn is_safe_category(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 20
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A Claude Code sessionId safe at every boundary it crosses: non-empty,
/// `[A-Za-z0-9_-]` only (real ids are UUIDs). Blocks shell metachars before the id
/// is folded into a command, and `.`/`/` before it becomes a `{sid}.jsonl` path
/// (reader.rs), so it can't traverse out of ~/.claude/projects. The ONE definition —
/// lib.rs commands and reader.rs both use it.
pub(crate) fn is_valid_session_id(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A session folder slug safe at its boundaries (filesystem path component, skill
/// prompt): non-empty, `[A-Za-z0-9._-]` only. Shared by restore_session,
/// reader::resolve_slug_cwd and pty::pty_spawn's restart_slug.
pub(crate) fn is_safe_slug(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Validate an optional space (`--root`) override: empty = no override (fine); otherwise
/// it must name a declared root AND be a safe token (it rides the skill prompt). Shared by
/// start_session + import_session so the rule lives once.
fn validate_root_override(cfg: &serde_json::Value, want_root: &str) -> Result<(), String> {
    if want_root.is_empty() {
        return Ok(());
    }
    let known = cfg.get("roots").and_then(serde_json::Value::as_array).is_some_and(|rs| {
        rs.iter().any(|r| r.get("name").and_then(serde_json::Value::as_str) == Some(want_root))
    });
    let safe = want_root.len() <= 30
        && want_root.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !known || !safe {
        return Err("invalid space".into());
    }
    Ok(())
}

/// Sanitize a session NAME for the skill prompt + YAML frontmatter + iTerm title:
/// whitespace collapsed to single spaces, restricted to unicode letters/digits/spaces +
/// a small punctuation set (excludes backtick, $, ", \\, newline — the chars that break
/// the downstream shell-quote / YAML / title), trimmed and capped at 120 chars. May
/// return "" (callers that require a title check for empty). Shared by start_session +
/// import_session.
fn sanitize_session_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_whitespace() { ' ' } else { c })
        .filter(|c| c.is_alphanumeric() || *c == ' ' || "-_.,'()".contains(*c))
        .collect();
    let joined = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(120).collect::<String>().trim().to_string()
}

/// Resume a session's full conversation in the user's terminal. sessionId is regex-
/// restricted; the cwd is POSIX single-quoted, and the `--model` value is shell-quoted
/// defensively (harmless for the plain `opus` alias, and safe if it ever grows brackets).
#[tauri::command]
fn open_in_terminal(cwd: String, session_id: String) -> Result<(), String> {
    if !is_valid_session_id(&session_id) {
        return Err("invalid session id".into());
    }
    // Closed sessions may send an empty/relative cwd — only cd when it's absolute.
    // --permission-mode auto: a resumed session must be able to run /close-session and
    // /save-session, which WRITE notes.md (and so bail in plan mode at their Step 0). Plan
    // mode would leave the session perpetually "stale" because the close never records.
    // Matches +New / Import (which already force auto for the same reason).
    let settings_arg = statusline_settings_arg();
    let cmd = if std::path::Path::new(&cwd).is_absolute() {
        format!(
            "cd {} && claude --resume {} --model {} --permission-mode auto{}",
            pty::shell_quote(&cwd),
            session_id,
            pty::shell_quote(pty::CLAUDE_MODEL),
            settings_arg,
        )
    } else {
        format!(
            "claude --resume {} --model {} --permission-mode auto{}",
            session_id,
            pty::shell_quote(pty::CLAUDE_MODEL),
            settings_arg,
        )
    };
    terminal::launch_in_terminal(&cmd)
}

/// A git branch name safe to pass to `git checkout` and into a shell command.
/// Allowlist (no shell metachars survive shell_quote anyway, but this also blocks
/// git ref ambiguities): no leading dash (flag smuggling), no leading/trailing `/`,
/// no `..` or `@{` (revision/reflog syntax). Used with `git checkout <b> --` so a
/// branch can never be reinterpreted as a pathspec.
fn is_safe_branch(b: &str) -> bool {
    !b.is_empty()
        && b.len() <= 200
        && !b.starts_with('-')
        && !b.starts_with('/')
        && !b.ends_with('/')
        && !b.contains("..")
        && !b.contains("@{")
        && b.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'/' | b'-'))
}

/// Validate a repo path BEFORE spawning iTerm: absolute, no leading dash, exists,
/// is a directory, and is actually a git repo. Returns the canonical path. This is
/// the only feedback channel — once iTerm is spawned, a failed `cd`/`checkout` is
/// invisible to the form (the spawn already succeeded), so we pre-flight here.
fn validate_repo(repo: &str) -> Result<std::path::PathBuf, String> {
    if repo.starts_with('-') {
        return Err("invalid repo path".into());
    }
    let p = std::path::Path::new(repo);
    if !p.is_absolute() {
        return Err("repo must be an absolute path".into());
    }
    let abs = p.canonicalize().map_err(|_| "repo folder not found".to_string())?;
    if !abs.is_dir() {
        return Err("repo is not a directory".into());
    }
    let is_git = std::process::Command::new("git")
        .arg("-C")
        .arg(&abs)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !is_git {
        return Err("that folder is not a git repository".into());
    }
    Ok(abs)
}

/// Launch a NEW session: open `claude` + the `/start-session` skill. Default (external)
/// opens a new iTerm tab; `embedded` instead returns the command + the notes.md path the
/// skill will create, so the dashboard can run it in an in-app pty (the renderer keys the
/// embedded terminal by that notesPath — see the embedded branch).
/// Launches from a chosen repo (cd + checkout the branch so the session starts on
/// it) when given, else the category's scope root. The app writes nothing itself —
/// /start-session creates the workspace (ADR-001/ADR-012). Category must pass the strict
/// token regex AND exist in config. Repo/branch are pre-flight-validated so errors
/// surface in the form, not as a dead iTerm tab.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // tauri command: one param per form field
fn start_session(
    category: String,
    name: String,
    ticket: String,
    repo: String,
    branch: String,
    pr_link: String,
    root: String,
    embedded: bool,
) -> Result<serde_json::Value, String> {
    let cfg = config::load();
    // Optional space (root) override — disambiguates a category present in 2+ spaces,
    // and decides the launch dir + the `--root` the skill writes under. Must be a
    // declared root and a safe token (it rides the /start-session prompt).
    let want_root = root.trim();
    validate_root_override(&cfg, want_root)?;
    let cats = cfg.get("categories").and_then(serde_json::Value::as_array);
    // Match the category by (name, root) when a space is given, so the right entry
    // (and thus the right launch dir) wins for a name that exists under several spaces.
    let cat_def = cats.and_then(|arr| {
        arr.iter().find(|c| {
            c.get("name").and_then(serde_json::Value::as_str) == Some(&category)
                && (want_root.is_empty()
                    || c.get("root").and_then(serde_json::Value::as_str) == Some(want_root))
        })
    });
    let cat_def = match cat_def {
        Some(c) if is_safe_category(&category) => c,
        _ => return Err("invalid category".into()),
    };

    // Title (the session name) — see sanitize_session_name for the allowed set.
    let safe_name = sanitize_session_name(&name);
    if safe_name.is_empty() {
        return Err("title required".into());
    }

    // Ticket: accept a project-key form (ABC-123); uppercased, else dropped.
    let t = ticket.trim();
    let safe_ticket = if is_ticket(t) { t.to_uppercase() } else { String::new() };

    // Optional repo + branch: validate up front (see validate_repo). A branch with
    // no repo is meaningless (nothing to check it out in) — reject early.
    let repo = repo.trim();
    let branch = branch.trim();
    if !branch.is_empty() && repo.is_empty() {
        return Err("pick a repo to check the branch out in".into());
    }
    let repo_abs = if repo.is_empty() { None } else { Some(validate_repo(repo)?) };
    if !branch.is_empty() {
        if !is_safe_branch(branch) {
            return Err("invalid branch name".into());
        }
        // Confirm the branch resolves in this repo (local or remote-tracking ref).
        let abs = repo_abs.as_ref().unwrap();
        let exists = std::process::Command::new("git")
            .arg("-C")
            .arg(abs)
            .args(["rev-parse", "--verify", "--quiet"])
            .arg(branch)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !exists {
            return Err(format!("branch '{branch}' not found in that repo"));
        }
    }

    // Optional reviewed-PR link (REVIEW sessions). Validated up front; appended as a
    // `--pr <url>` token the /start-session skill recognises and writes to the frontmatter.
    let pr = pr_link.trim();
    if !pr.is_empty() && !is_pr_url(pr) {
        return Err("not a GitHub PR URL (https://github.com/owner/repo/pull/N)".into());
    }

    // /start-session parses: <CATEGORY> [<TICKET>] <name> [--pr <url>] [--root <space>]
    let parts: Vec<&str> = [category.as_str(), safe_ticket.as_str(), safe_name.as_str()]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect();
    let mut prompt = format!("/start-session {}", parts.join(" "));
    if !pr.is_empty() {
        prompt.push_str(&format!(" --pr {pr}"));
    }
    // Tell the skill which space to write under (only when one was chosen) — resolves
    // a category that exists in several spaces. Validated as a safe token above.
    if !want_root.is_empty() {
        prompt.push_str(&format!(" --root {want_root}"));
    }
    let model = pty::CLAUDE_MODEL;
    // Start NEW sessions in auto mode. /start-session must WRITE notes.md + register the
    // session in active-sessions.json — plan mode BLOCKS that (the skill aborts at its
    // mode check), so a +New in plan mode silently does nothing. `--permission-mode auto`
    // forces a writable mode regardless of the user's persisted default. (Resume/Restart
    // keep the session's own mode — this is only for fresh sessions.) `auto` is a fixed
    // literal, no quoting needed.
    let settings_arg = statusline_settings_arg();
    let claude = format!(
        "claude --model {} --permission-mode auto{} {}",
        pty::shell_quote(model),
        settings_arg,
        pty::shell_quote(&prompt),
    );

    // Launch dir: the repo (start ON the branch) when given, else the scope root.
    let cmd = if let Some(abs) = &repo_abs {
        let cd = pty::shell_quote(&abs.to_string_lossy());
        if branch.is_empty() {
            format!("cd {cd} && {claude}")
        } else {
            // `git checkout <branch> --` — the trailing `--` stops the branch from
            // being reinterpreted as a pathspec; `&&` so a failed checkout aborts
            // (visible in iTerm) rather than starting on the wrong branch.
            format!("cd {} && git checkout {} -- && {}", cd, pty::shell_quote(branch), claude)
        }
    } else {
        let launch_dir = category_root_dir(&cfg, cat_def);
        format!("cd {} && {}", pty::shell_quote(&launch_dir), claude)
    };
    if embedded {
        // Embedded: the dashboard runs `cmd` itself in an in-app pty (not iTerm), so
        // return the command verbatim + the notes.md path the /start-session skill WILL
        // create. The renderer keys the embedded terminal by that notesPath — which is
        // the session's eventual sessionKey — so the card links to its terminal with no
        // re-key, and pty_spawn's idempotency guard (keyed on it) blocks a double-client.
        // notesPath MUST match the skill's TARGET_DIR (aoconfig.py `dir`):
        // <category root>/<CATEGORY>/<folder>/notes.md, folder = ticket || slugify(name).
        // slugify is byte-faithful to the skill's slug(); keep both in sync.
        let folder = if safe_ticket.is_empty() { slugify(&safe_name) } else { safe_ticket.clone() };
        // A name with no ASCII alphanumerics (e.g. "..." or "éé") slugifies to "" —
        // the notesPath would collapse to <base>/<CAT>//notes.md and the skill's own
        // slug() would bootstrap a mismatched (category-level) dir. Surface it in the
        // form instead of launching a broken session.
        if folder.is_empty() {
            return Err("title needs at least one letter or digit (a-z, 0-9)".into());
        }
        let base = category_root_dir(&cfg, cat_def);
        let notes_path = format!("{base}/{category}/{folder}/notes.md");
        return Ok(serde_json::json!({ "command": cmd, "notesPath": notes_path }));
    }
    terminal::launch_in_terminal(&cmd)?;
    Ok(serde_json::json!({}))
}

/// Slugify a session NAME into a folder slug, byte-faithful to the /start-session skill's
/// `slug()` = `tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g'`.
/// ASCII-ONLY on purpose (matches `sed` under the C locale): non-ASCII chars become a
/// dash, e.g. "Café" → "caf", "réseau" → "r-seau". Used by embedded start_session to
/// predict the skill's notes.md folder — must stay in lockstep with the skill's slug().
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for c in name.chars() {
        let lc = c.to_ascii_lowercase(); // lowercases ASCII A-Z only; leaves others as-is
        if lc.is_ascii_alphanumeric() {
            out.push(lc);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-'); // collapse any run of non-[a-z0-9] to a single dash
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Launch dir for a NEW session in this category: the path of the category's
/// configured `root` (v2 — `derive()` sets `root` on every category). Falls back to
/// the first root, then to home. Keeps a moved-to-a-custom-root category launching
/// from the right place.
fn category_root_dir(cfg: &serde_json::Value, cat_def: &serde_json::Value) -> String {
    let home = cfg.get("home").and_then(serde_json::Value::as_str).unwrap_or("/");
    // v2: resolve the category's root name → its path in cfg.roots.
    if let Some(root_name) = cat_def.get("root").and_then(serde_json::Value::as_str) {
        if let Some(roots) = cfg.get("roots").and_then(serde_json::Value::as_array) {
            if let Some(path) = roots
                .iter()
                .find(|r| r.get("name").and_then(serde_json::Value::as_str) == Some(root_name))
                .and_then(|r| r.get("path").and_then(serde_json::Value::as_str))
            {
                return path.to_string();
            }
        }
    }
    // Fallback: use first root's path, or home.
    if let Some(roots) = cfg.get("roots").and_then(serde_json::Value::as_array) {
        if let Some(path) = roots.first()
            .and_then(|r| r.get("path").and_then(serde_json::Value::as_str)) {
            return path.to_string();
        }
    }
    home.to_string()
}

/// Reopen a closed/archived session: launch `claude` + the `/restart-session` skill, which
/// reloads the session's notes into a fresh session and re-registers it as active
/// (un-archiving it). Launcher only — the app writes nothing (ADR-001/ADR-012).
/// Distinct from resume: `/restart-session` reloads the notes summary, not the raw transcript,
/// so it works for sessions with no recorded sessionId (e.g. "to fill").
#[tauri::command]
fn restore_session(slug: String, session_id: String) -> Result<(), String> {
    // Slug is a folder name (allows '.') — validate at the boundary before it
    // reaches the filesystem/prompt. sessionId, if present, must be a clean id.
    if !is_safe_slug(&slug) {
        return Err("invalid slug".into());
    }
    if !session_id.is_empty() && !is_valid_session_id(&session_id) {
        return Err("invalid sessionId".into());
    }
    // cd into the session's launch dir so /restart-session lands in the right place.
    // Prefer the transcript's launch cwd; for closed/archived sessions (no transcript)
    // fall back to the session's SPACE root resolved from its notes.md location — NOT
    // $HOME, so a Work session restarts in Work. $HOME only if even that can't be found.
    let dir = if session_id.is_empty() { None } else { reader::resolve_session_cwd(&session_id) }
        .or_else(|| reader::resolve_slug_cwd(&slug))
        .unwrap_or_else(|| config::home().to_string_lossy().into_owned());

    let prompt = format!("/restart-session {slug}");
    // --permission-mode auto: /restart-session writes (re-registers + checks out the
    // branch) and the reopened session must be able to /close-session later — both bail in
    // plan mode. Matches +New / Import / Resume.
    let settings_arg = statusline_settings_arg();
    let cmd = format!(
        "cd {} && claude --model {} --permission-mode auto{} {}",
        pty::shell_quote(&dir),
        pty::shell_quote(pty::CLAUDE_MODEL),
        settings_arg,
        pty::shell_quote(&prompt),
    );
    terminal::launch_in_terminal(&cmd)
}

/// Import (adopt) an existing Claude Code session into management: `--resume` it and
/// run the `/import-session` skill so it gets a notes.md + registration. The app only launches;
/// the skill does the writing (ADR-012). cwd = the session's launch dir (where
/// `--resume` must run). Category must be one the user configured.
#[tauri::command(async)]
fn import_session(session_id: String, category: String, name: String, root: String, embedded: bool) -> Result<serde_json::Value, String> {
    if !is_valid_session_id(&session_id) {
        return Err("invalid sessionId".into());
    }
    let category = category.trim().to_uppercase();
    if !is_safe_category(&category) {
        return Err("invalid category".into());
    }
    let cfg = config::load();
    let known = cfg.get("categories").and_then(serde_json::Value::as_array).is_some_and(|arr| {
        arr.iter().any(|c| c.get("name").and_then(serde_json::Value::as_str) == Some(&category))
    });
    if !known {
        return Err("unknown category — add it in Settings first".into());
    }
    // Optional space (root): which space the imported session's notes.md lands under,
    // for a category that exists in several. Mirrors start_session.
    let want_root = root.trim();
    validate_root_override(&cfg, want_root)?;
    // Same safe-name set as /start-session (no shell / YAML-breaking chars); may be empty.
    let safe_name = sanitize_session_name(&name);

    let dir = reader::resolve_session_cwd(&session_id)
        .unwrap_or_else(|| config::home().to_string_lossy().into_owned());
    let mut prompt = if safe_name.is_empty() {
        format!("/import-session {category}")
    } else {
        format!("/import-session {category} {safe_name}")
    };
    if !want_root.is_empty() {
        prompt.push_str(&format!(" --root {want_root}"));
    }
    // --permission-mode auto: /import-session must WRITE the notes.md + register the
    // session; plan mode blocks that (same wall +New hit). Force a writable mode on the
    // resumed session so the adoption goes through. Resume cwd stays the session's own
    // dir (claude --resume keys by directory); the space only decides where notes land.
    let settings_arg = statusline_settings_arg();
    let cmd = format!(
        "cd {} && claude --resume {} --model {} --permission-mode auto{} {}",
        pty::shell_quote(&dir),
        pty::shell_quote(&session_id),
        pty::shell_quote(pty::CLAUDE_MODEL),
        settings_arg,
        pty::shell_quote(&prompt),
    );
    if embedded {
        // Embedded: the dashboard runs this in an in-app pty (not iTerm). The session's
        // real id is already known (it's what we --resume), so the renderer keys the pane
        // by it → it links to the card via the normal sessionId reveal, no re-key needed.
        return Ok(serde_json::json!({ "command": cmd }));
    }
    terminal::launch_in_terminal(&cmd)?;
    Ok(serde_json::json!({}))
}

/// True for a project-key ticket like `ABC-123` (letter, alnum*, dash, digits).
fn is_ticket(t: &str) -> bool {
    let (key, num) = match t.split_once('-') {
        Some(kv) => kv,
        None => return false,
    };
    !key.is_empty()
        && key.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
        && key.bytes().all(|b| b.is_ascii_alphanumeric())
        && !num.is_empty()
        && num.bytes().all(|b| b.is_ascii_digit())
}

/// Percent-encode a string for safe use as a URL query value (unreserved chars
/// pass through; everything else becomes %XX). The detached window reads it back
/// via URLSearchParams, which decodes it.
fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Stable, always-valid window label for a session key (which may be a notesPath
/// full of `/` and `.` that Tauri rejects as a label). FNV-1a → hex.
fn label_for(key: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("detail-{h:016x}")
}

/// Detach a session into its own window (port of the Electron detach-session). The
/// key (running notesPath/sessionId, or historical key) is passed as a query param;
/// detail.html's detail-window.js looks the session up across all tabs. Re-detaching
/// the same session focuses the existing window instead of opening a duplicate.
#[tauri::command]
fn detach_session(app: tauri::AppHandle, key: String) -> Result<(), String> {
    if key.is_empty() {
        return Err("invalid key".into());
    }
    let label = label_for(&key);
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let url = format!("detail.html?key={}", percent_encode(&key));
    let builder = tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
        .title("")
        .inner_size(560.0, 720.0)
        .min_inner_size(360.0, 420.0);
    // `title_bar_style` is a macOS-only builder method; on other platforms the
    // Overlay style is implied by the config and this call would not compile.
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    builder.build().map(|_| ()).map_err(|e| e.to_string())
}

/// Toggle the calling window's always-on-top ("pin"). Acts only on the sender's
/// own window; returns the requested state (the renderer tracks it from there).
#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, flag: bool) -> bool {
    let _ = window.set_always_on_top(flag);
    flag
}

/// Match the native window background to the active theme, so a window RESIZE doesn't
/// briefly flash the OS default (white) at the growing edge before the dark webview
/// repaints. On macOS this sets the NSWindow layer (the webview layer is a no-op there) —
/// exactly the layer drawn during a live resize. Called from applyTheme() at boot + on
/// every theme toggle. Colours mirror `--bg` in style.css.
#[tauri::command]
fn set_window_bg(window: tauri::WebviewWindow, dark: bool) {
    let c = if dark {
        tauri::window::Color(28, 28, 30, 255)
    } else {
        tauri::window::Color(245, 245, 247, 255)
    };
    let _ = window.set_background_color(Some(c));
}

/// Write `body` to `path` atomically (tmp + fsync + rename), so a crash never leaves
/// a half-written session file. The fsync matters: rename-over is only atomic for
/// data already flushed to the tmp file — a power loss between the rename and the
/// delayed writeback could otherwise replace a good file with an empty one. The one
/// atomic-write implementation (config::save uses it too).
pub(crate) fn atomic_write(path: &std::path::Path, body: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_extension("ao-tmp");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Local (`date`-derived) current stamp as `("YYYY-MM-DD", "HH:MM")`. Spawning `date`
/// (not chrono) is deliberate: it matches byte-for-byte how the session skills stamp
/// notes.md (`date +%Y-%m-%d …` = local civil time), and these writes must classify
/// identically in reader.rs. None when the spawn fails or prints an unexpected shape.
/// The one definition — archive_session / close_session / notes_closed_since all
/// stamped via their own inline `date` spawn before.
fn local_date_time() -> Option<(String, String)> {
    let out = std::process::Command::new("date").arg("+%Y-%m-%d %H:%M").output().ok()?;
    let s = String::from_utf8(out.stdout).ok()?;
    let (d, t) = s.trim().split_once(' ')?;
    (d.len() == 10 && t.len() == 5).then(|| (d.to_string(), t.to_string()))
}

/// Every configured root, canonicalized (v2 `roots` list only).
/// Non-existent roots drop out (canonicalize fails). Shared by the confinement checks so
/// the "what counts as a root" list lives once.
fn configured_roots() -> Vec<std::path::PathBuf> {
    let cfg = config::load();
    let mut roots: Vec<String> = Vec::new();
    if let Some(arr) = cfg.get("roots").and_then(serde_json::Value::as_array) {
        for r in arr {
            if let Some(p) = r.get("path").and_then(serde_json::Value::as_str) {
                roots.push(p.to_string());
            }
        }
    }
    roots.iter().filter_map(|r| std::path::Path::new(r).canonicalize().ok()).collect()
}

/// A folder is safe to trash as a session iff it is a session dir — strictly nested
/// at least two levels below a configured root (`<root>/<CATEGORY>/<slug>`, which is
/// where the scanner surfaces every managed notes.md). This blocks trashing a root
/// itself or a whole category dir when the notes.md is shallow-nested (a hand-crafted
/// active-sessions.json or a misconfig could otherwise make delete_session's
/// `abs.parent()` resolve to a root).
fn is_deletable_session_dir(dir: &std::path::Path, roots: &[std::path::PathBuf]) -> bool {
    // Measure depth from the MOST SPECIFIC (longest) matching root — roots can nest
    // (the default config has Perso=~ containing Work=~/work), so a category dir under
    // the inner root would otherwise look session-deep under the outer one.
    roots
        .iter()
        .filter(|root| dir.starts_with(root))
        .max_by_key(|root| root.components().count())
        .and_then(|root| dir.strip_prefix(root).ok())
        .map(|rel| rel.components().count() >= 2)
        .unwrap_or(false)
}

/// Resolve a notes.md path the app is allowed to WRITE: a real `notes.md` file
/// confined under a configured root. Shared by the two source-of-truth writes
/// (archive + pr_link) so the confinement rule lives once. Checks EVERY configured
/// root — the v2 `roots` list plus the legacy workRoot/personalRoot — so a session
/// under a custom root isn't wrongly rejected.
fn notes_md_under_root(notes_path: &str) -> Result<std::path::PathBuf, String> {
    if notes_path.starts_with('-') {
        return Err("invalid path".into());
    }
    let abs = std::path::Path::new(notes_path)
        .canonicalize()
        .map_err(|_| "notes.md not found".to_string())?;
    if !abs.is_file() || abs.file_name().and_then(|n| n.to_str()) != Some("notes.md") {
        return Err("not a notes.md file".into());
    }
    let under_root = configured_roots().iter().any(|root| abs.starts_with(root));
    if !under_root {
        return Err("notes.md is outside the configured roots".into());
    }
    Ok(abs)
}

/// A GitHub pull-request URL: `https://github.com/<owner>/<repo>/pull/<number>`,
/// optionally followed by `/…`, `#…` or `?…`. No whitespace (also keeps it safe to
/// embed in the /start-session shell command, which we shell-quote anyway).
fn is_pr_url(url: &str) -> bool {
    if url.chars().any(|c| c.is_whitespace()) {
        return false;
    }
    let Some(rest) = url.strip_prefix("https://github.com/") else {
        return false;
    };
    let parts: Vec<&str> = rest.splitn(4, '/').collect();
    if parts.len() < 4 || parts[0].is_empty() || parts[1].is_empty() || parts[2] != "pull" {
        return false;
    }
    parts[3].chars().next().is_some_and(|c| c.is_ascii_digit())
}

/// Write a session's link list (PRs or tickets) into the leading `---` frontmatter,
/// in the additive shape the reader expects (reader::frontmatter_values): the FIRST
/// value goes on the `singular` line (`pr_link:` / `ticket:` — the primary, which the
/// skills also write), any others follow as a `plural` block list:
///
/// ```yaml
/// pr_link: https://github.com/o/r/pull/12
/// pr_links:
///   - https://github.com/o/r/pull/15
/// ```
///
/// Both keys are rewritten from scratch each time, so dropping back to one value
/// removes the now-empty `plural:` block and an empty list clears both — no stale
/// link can survive. The list is written at the primary key's existing position when
/// it had one (keeping frontmatter order stable), else appended. Content with no
/// frontmatter block is returned unchanged (every session notes.md has frontmatter).
fn set_frontmatter_links(content: &str, singular: &str, plural: &str, values: &[String]) -> String {
    let Some(rest) = content.strip_prefix("---\n") else {
        return content.to_string();
    };
    let Some(end) = rest.find("\n---") else {
        return content.to_string();
    };
    let (fm, tail) = (&rest[..end], &rest[end..]); // tail starts at "\n---…"
    // The replacement block: primary line + one item line per extra.
    let mut block: Vec<String> = Vec::new();
    if let Some((first, extras)) = values.split_first() {
        block.push(format!("{singular}: {first}"));
        if !extras.is_empty() {
            block.push(format!("{plural}:"));
            block.extend(extras.iter().map(|v| format!("  - {v}")));
        }
    }

    let mut lines: Vec<String> = Vec::new();
    let mut placed = false;
    let mut in_plural = false; // inside the old plural block → drop its item lines
    for l in fm.lines() {
        let key = l.split_once(':').map(|(k, _)| k.trim()).unwrap_or("");
        if in_plural {
            // A `- item` line still belongs to the old block; anything else ends it.
            if reader::is_frontmatter_list_item(l) {
                continue;
            }
            in_plural = false;
        }
        if key == plural {
            in_plural = true;
            continue; // replaced by `block` (emitted at the primary's position)
        }
        if key == singular {
            if !placed {
                lines.extend(block.iter().cloned());
                placed = true;
            }
            continue;
        }
        lines.push(l.to_string());
    }
    if !placed {
        lines.extend(block);
    }
    format!("---\n{}{}", lines.join("\n"), tail)
}

/// Append an ARCHIVED bullet at the end of the `## Session history` section
/// (creating the section if absent). Pure + unit-tested — mirrors what /archive-session
/// writes. The dashboard classifies a session as Archived from any history line
/// containing "ARCHIVED" (reader.rs::session_history_info).
fn stamp_archived(content: &str, line: &str) -> String {
    const MARKER: &str = "## Session history";
    match content.find(MARKER) {
        Some(hpos) => {
            // End of the header line, then the section runs to the next "## " / EOF.
            let after_header = content[hpos..].find('\n').map(|i| hpos + i + 1).unwrap_or(content.len());
            let sec_end = content[after_header..]
                .find("\n## ")
                .map(|i| after_header + i)
                .unwrap_or(content.len());
            let body = content[after_header..sec_end].trim_end();
            let new_body = if body.is_empty() { format!("{line}\n") } else { format!("{body}\n{line}\n") };
            format!("{}{}{}", &content[..after_header], new_body, &content[sec_end..])
        }
        None => format!("{}\n\n{MARKER}\n{line}\n", content.trim_end()),
    }
}

/// Drop any active-sessions.json entry pointing at this notes.md (atomic, rewritten
/// only when something changed). Matches the path both as sent and canonicalized — the
/// registry may store either form. Shared by archive_session and delete_session.
fn remove_from_active_sessions(notes_path: &str, abs: &std::path::Path) -> Result<(), String> {
    let active = config::home().join(".claude").join("active-sessions.json");
    if let Ok(s) = std::fs::read_to_string(&active) {
        if let Ok(serde_json::Value::Object(mut map)) = serde_json::from_str(&s) {
            let canon = abs.to_string_lossy();
            let before = map.len();
            map.retain(|_, v| {
                let np = v.get("notes_path").and_then(serde_json::Value::as_str);
                np != Some(notes_path) && np != Some(canon.as_ref())
            });
            if map.len() != before {
                let body = serde_json::to_string_pretty(&serde_json::Value::Object(map))
                    .map_err(|e| e.to_string())?;
                atomic_write(&active, &body)?;
            }
        }
    }
    Ok(())
}

/// Drop every genuine ARCHIVED marker line from the notes. A marker is a pipe-delimited
/// entry whose own field is exactly `ARCHIVED` (what stamp_archived writes) — prose that
/// merely mentions the word is preserved, matching reader.rs::session_history_info. Pure +
/// unit-tested; idempotent, so it's safe to run on every resume. Mirrors the un-archive
/// step of the /restart-session skill.
fn strip_archived(content: &str) -> String {
    let kept: Vec<&str> = content
        .lines()
        .filter(|l| {
            !(l.trim_start().starts_with('-') && l.split('|').any(|seg| seg.trim() == "ARCHIVED"))
        })
        .collect();
    let mut out = kept.join("\n");
    if content.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Un-archive a session: strip its ARCHIVED marker so resuming archived work pulls it
/// back into the live lifecycle (it lands in Closed/stale when it stops, not straight
/// back into Archived). Called on every resume — a no-op when there's no marker. Writes
/// are atomic and confined to a real notes.md under a configured root.
#[tauri::command(async)]
fn unarchive_session(notes_path: String) -> Result<(), String> {
    let abs = notes_md_under_root(&notes_path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    let stripped = strip_archived(&content);
    if stripped == content {
        return Ok(()); // nothing to do — don't rewrite the file
    }
    atomic_write(&abs, &stripped)
}

/// Archive a session FROM THE DASHBOARD (ADR-013 — the app's one source-of-truth
/// write, a deliberate derogation from ADR-001): stamps ARCHIVED into notes.md and
/// drops the session from active-sessions.json. Mirrors the /archive-session skill. Writes
/// are atomic and confined to a real notes.md under a configured root.
#[tauri::command(async)]
fn archive_session(notes_path: String) -> Result<(), String> {
    let abs = notes_md_under_root(&notes_path)?;

    // 1) Stamp ARCHIVED into notes.md (atomic).
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    let date = local_date_time().map(|(d, t)| format!("{d} {t}")).unwrap_or_default();
    let line = format!("- {date} | ARCHIVED | archived from the dashboard");
    atomic_write(&abs, &stamp_archived(&content, &line))?;

    // 2) Drop matching entries from active-sessions.json (atomic).
    remove_from_active_sessions(&notes_path, &abs)?;
    Ok(())
}

/// Permanently remove an ARCHIVED session by moving its session folder to the OS Trash
/// (recoverable from the Finder) — the disk-declutter action (ADR-014). Guards: the path
/// must resolve to a real notes.md confined under a configured root (notes_md_under_root),
/// AND the session must classify as archived — running/closed work is never deletable here.
#[tauri::command(async)]
fn delete_session(notes_path: String) -> Result<(), String> {
    let abs = notes_md_under_root(&notes_path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    if reader::session_history_info(&content).0 != "archived" {
        return Err("only archived sessions can be deleted".into());
    }
    // Session folder = the notes.md's parent. notes_md_under_root proved it's confined
    // under a root, but NOT that it's properly nested — a notes.md sitting directly in a
    // root (or a category dir) would make `dir` the root/category itself and trash every
    // session under it. Require a real session dir (<root>/<CATEGORY>/<slug>) before any
    // destructive move.
    let dir = abs.parent().filter(|p| p.is_dir()).ok_or("session folder not found")?;
    if !is_deletable_session_dir(dir, &configured_roots()) {
        return Err("refusing to delete: not a nested session folder".into());
    }
    // Move to the OS Trash (recoverable) rather than an irreversible hard delete.
    trash::delete(dir).map_err(|e| e.to_string())?;

    // Defensive: drop any active-sessions.json entry pointing at this notes.md.
    remove_from_active_sessions(&notes_path, &abs)?;
    Ok(())
}

/// Trim, drop blanks and de-duplicate an incoming link list, preserving order. The
/// editor is a free-text box (one entry per line), so blank lines and an accidentally
/// pasted duplicate are expected input, not errors.
fn clean_link_list(values: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in values {
        let v = v.trim().to_string();
        if !v.is_empty() && !out.iter().any(|x| x == &v) {
            out.push(v);
        }
    }
    out
}

/// Set / update / clear the PR links on a session (ADR-013 family — the app's 2nd
/// bounded source-of-truth write). A session may carry SEVERAL PRs (one task split
/// across two of them); every entry must be a GitHub PR URL, an empty list clears them.
/// Rewrites the `pr_link:` / `pr_links:` frontmatter atomically, confined under a root.
#[tauri::command(async)]
fn set_pr_links(notes_path: String, urls: Vec<String>) -> Result<(), String> {
    let urls = clean_link_list(urls);
    if let Some(bad) = urls.iter().find(|u| !is_pr_url(u)) {
        return Err(format!(
            "not a GitHub PR URL (https://github.com/owner/repo/pull/N): {bad}"
        ));
    }
    let abs = notes_md_under_root(&notes_path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    atomic_write(&abs, &set_frontmatter_links(&content, "pr_link", "pr_links", &urls))
}

/// Set / update / clear the tickets on a session — same contract as set_pr_links, for
/// the tracker side (a task plus its sub-task). Ids are uppercased and must match the
/// project-key form (ABC-123); an empty list clears them.
///
/// Only notes.md is written. active-sessions.json keeps mirroring the PRIMARY ticket
/// alone (that's what the skills register and rename the session with), and the reader
/// folds the registry ticket in front of this list — so the extras live in exactly one
/// place and can't drift.
#[tauri::command(async)]
fn set_tickets(notes_path: String, tickets: Vec<String>) -> Result<(), String> {
    let tickets: Vec<String> =
        clean_link_list(tickets).into_iter().map(|t| t.to_uppercase()).collect();
    if let Some(bad) = tickets.iter().find(|t| !is_ticket(t)) {
        return Err(format!("not a ticket id (ABC-123): {bad}"));
    }
    let abs = notes_md_under_root(&notes_path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    atomic_write(&abs, &set_frontmatter_links(&content, "ticket", "tickets", &tickets))
}

/// Has this session's notes.md been freshly wrapped up (a `/close-session` write) since
/// `since_ms`? The embedded "End session" button injects `/close-session` into the live
/// pty, then polls this until the wrap-up is written — then it kills the pty so the
/// session moves to Closed (not stale). Read-only, confined to a notes.md under a root.
///
/// Requires the latest Session history entry to be a close dated **today** — NOT merely
/// "status closed + file touched". A session with a pre-existing (older) close entry
/// already reads as "closed", so /close-session's early section writes (Decisions/Files)
/// bump the mtime and would trip a status-only check BEFORE it appends the fresh close
/// line — killing the pty too early, so no today-dated close is recorded and
/// reopened_after_close (transcript touched today > the old close date) flips it to stale.
/// Gating on a today-dated close both fixes that race and guarantees the recorded close is
/// same-day as the transcript, so it won't be flipped.
#[tauri::command]
fn notes_closed_since(notes_path: String, since_ms: f64) -> Result<bool, String> {
    let abs = notes_md_under_root(&notes_path)?;
    let mtime_ms = std::fs::metadata(&abs)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    if mtime_ms + 1000.0 < since_ms {
        return Ok(false); // not written since we injected /close-session
    }
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    let (status, date) = reader::session_history_info(&content);
    if status != "closed" {
        return Ok(false);
    }
    // The close entry must be dated today (local, matching how /close-session and
    // close_session stamp it) — else an older close reads as "closed" and trips this early.
    let today = local_date_time().map(|(d, _)| d);
    Ok(today.is_some_and(|t| date.as_deref().is_some_and(|d| d.starts_with(&t))))
}

/// Stamp a close marker directly into the session's notes.md history — the guaranteed
/// fallback for the "End session" button when `/close-session` produced no fresh wrap-up
/// (nothing new to summarise, or it was in plan mode). Ensures the session lands in
/// **Closed**, not stale, even without an AI summary. Idempotent for today: if it's
/// already wrapped up with TODAY's date, do nothing (avoids a duplicate when
/// /close-session did write). Mirrors archive_session's confined atomic write.
#[tauri::command]
fn close_session(notes_path: String) -> Result<(), String> {
    let abs = notes_md_under_root(&notes_path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    let (date, time) =
        local_date_time().ok_or("could not determine the current date")?;
    let (date, time) = (date.as_str(), time.as_str());
    // Already closed today (e.g. /close-session just wrote a fresh wrap-up) → no double-stamp.
    let (status, last_date) = reader::session_history_info(&content);
    if status == "closed" && last_date.as_deref() == Some(date) {
        return Ok(());
    }
    // `?? → HH:MM` is the legacy close shape is_wrapped_up recognises (no session id needed).
    let line =
        format!("- {date} ?? → {time} | closed from the dashboard (ended without a /close-session summary)");
    atomic_write(&abs, &stamp_archived(&content, &line))
}

/// Parse statusline-cache.json (or any JSON) into a serde_json Value.
/// Valid JSON object → the object; anything else (garbage, scalar values) → Null.
fn parse_usage(content: &str) -> Value {
    match serde_json::from_str::<Value>(content) {
        Ok(v) if v.is_object() => v,
        _ => Value::Null,
    }
}

/// Build the renderer's usage payload from the cache. New keyed shape is
/// `{ global: {rate limits}, sessions: { <session_id>: {model, contextPct} } }`;
/// the legacy flat shape (all fields at top level) is tolerated. Rate limits always
/// come from `global` (or the flat root); model + contextPct come from the requested
/// session (or, for a legacy flat cache with no session requested, the flat root).
/// Returns Null when `cache` is not an object.
fn usage_view(cache: &Value, session_id: Option<&str>) -> Value {
    let obj = match cache.as_object() {
        Some(o) => o,
        None => return Value::Null,
    };
    let has_new = obj.contains_key("global") || obj.contains_key("sessions");
    let g = if has_new {
        obj.get("global").and_then(Value::as_object).cloned().unwrap_or_default()
    } else {
        obj.clone()
    };
    let mut out = serde_json::Map::new();
    for k in ["fiveHourPct", "sevenDayPct", "fiveHourResetsAt", "sevenDayResetsAt", "updatedAt"] {
        if let Some(v) = g.get(k) { out.insert(k.to_string(), v.clone()); }
    }
    // model + contextPct: from the session entry (new shape) or the flat root (legacy, no id).
    let (model, ctx) = if has_new {
        let s = session_id
            .and_then(|id| obj.get("sessions").and_then(Value::as_object).and_then(|m| m.get(id)))
            .and_then(Value::as_object);
        (s.and_then(|s| s.get("model")).cloned(),
         s.and_then(|s| s.get("contextPct")).cloned())
    } else if session_id.is_none() {
        (obj.get("model").cloned(), obj.get("contextPct").cloned())
    } else {
        (None, None)
    };
    out.insert("model".to_string(), model.unwrap_or(Value::Null));
    out.insert("contextPct".to_string(), ctx.unwrap_or(Value::Null));
    Value::Object(out)
}

/// Read the Claude Code statusline cache file (~/.claude/statusline-cache.json)
/// and return its parsed JSON, optionally filtered for a specific session.
/// Returns Null if the file is absent, unreadable, or contains invalid/non-object JSON.
/// Never errors — always returns a Value.
#[tauri::command]
fn get_usage(session_id: Option<String>) -> Value {
    let cache_path = config::home()
        .join(".claude")
        .join("statusline-cache.json");
    let cache = match std::fs::read_to_string(&cache_path) {
        Ok(content) => parse_usage(&content),
        Err(_) => return Value::Null,
    };
    usage_view(&cache, session_id.as_deref())
}

/// Open a native folder picker for Settings; returns the chosen absolute path, or
/// null if cancelled. MUST stay `async`: the native panel (rfd) runs on the main
/// thread and `blocking_pick_folder` blocks the caller on a channel — only safe
/// when invoked off the main thread, which `command(async)` guarantees. A sync
/// command here would deadlock the app the moment Browse is clicked.
#[tauri::command(async)]
fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Multi-folder picker (Settings → add several categories at once). Same `async`
/// requirement as `pick_directory`. Returns the chosen absolute paths (empty if
/// cancelled).
#[tauri::command(async)]
fn pick_directories(app: tauri::AppHandle) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    app.dialog()
        .file()
        .blocking_pick_folders()
        .map(|paths| {
            paths
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Export all UI settings (a JSON object built by the renderer from its localStorage
/// `csm.*` keys) to a user-chosen file. The app never writes settings on its own —
/// this is the explicit, manual backup the user takes before a reinstall.
#[tauri::command(async)]
fn export_settings(app: tauri::AppHandle, json: String) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    // Refuse to write anything that isn't a JSON object (guards against junk on disk).
    if !serde_json::from_str::<serde_json::Value>(&json).map(|v| v.is_object()).unwrap_or(false) {
        return Err("settings payload is not a JSON object".into());
    }
    let path = app
        .dialog()
        .file()
        .set_file_name("ai-agents-orchestrator-settings.json")
        .add_filter("JSON", &["json"])
        .blocking_save_file()
        .and_then(|p| p.into_path().ok());
    match path {
        Some(p) => {
            std::fs::write(&p, json).map_err(|e| e.to_string())?;
            Ok(true)
        }
        None => Ok(false), // user cancelled
    }
}

/// Let the user pick a previously-exported settings file; return its contents for the
/// renderer to load back into localStorage. Validated to be a JSON object.
#[tauri::command(async)]
fn import_settings(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let path = app
        .dialog()
        .file()
        .add_filter("JSON", &["json"])
        .blocking_pick_file()
        .and_then(|p| p.into_path().ok());
    match path {
        Some(p) => {
            let content = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
            if !serde_json::from_str::<serde_json::Value>(&content).map(|v| v.is_object()).unwrap_or(false) {
                return Err("that file isn't a valid settings export".into());
            }
            Ok(Some(content))
        }
        None => Ok(None), // cancelled
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(pty::PtyManager::new())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Install the statusline wrapper (idempotent, best-effort).
            statusline::install_if_needed();

            // v1 → v2 migration (idempotent, run-once at startup).
            match config::migrate_v1_if_needed() {
                Ok(true) => {
                    eprintln!("[ai-agents-orchestrator] Config migrated to v2 (backup saved)");
                    // Emit a Tauri event so the renderer can show a toast.
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.emit("config_migrated_v2", ());
                    }
                }
                Ok(false) => {
                    // No migration needed.
                }
                Err(e) => {
                    eprintln!("[ai-agents-orchestrator] Config migration failed: {e}");
                }
            }
            // One-time startup diagnostic: a missing scan root means the app will
            // silently show no sessions there — the #1 confusing first-run state.
            // Surface it (don't fail) so a tester who skipped install.sh sees why.
            let cfg = config::load();
            for r in cfg.get("roots").and_then(serde_json::Value::as_array).unwrap_or(&vec![]) {
                if let Some(path) = r.get("path").and_then(serde_json::Value::as_str) {
                    if !std::path::Path::new(path).exists() {
                        let name = r.get("name").and_then(serde_json::Value::as_str).unwrap_or("(unknown)");
                        eprintln!(
                            "[ai-agents-orchestrator] configured root '{name}' path '{path}' does not exist — \
                             sessions there won't be found (run scripts/install.sh, or set it in Settings)"
                        );
                    }
                }
            }
            // Paint the window dark from the first frame (the default theme), so the
            // initial paint + any resize before the renderer's applyTheme() runs doesn't
            // flash the OS-default white. applyTheme() corrects it if the saved theme is light.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_background_color(Some(tauri::window::Color(28, 28, 30, 255)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config::get_config,
            config::set_config,
            reader::get_sessions,
            reader::get_historical_sessions,
            reader::get_historical_sessions_all,
            reader::discover_sessions,
            reader::discover_sessions_page,
            open_external,
            open_path,
            open_in_terminal,
            start_session,
            restore_session,
            import_session,
            detach_session,
            set_always_on_top,
            set_window_bg,
            pick_directory,
            pick_directories,
            export_settings,
            import_settings,
            archive_session,
            unarchive_session,
            delete_session,
            set_pr_links,
            set_tickets,
            notes_closed_since,
            close_session,
            can_reveal_terminal,
            reveal_terminal,
            get_usage,
            skills::install_skills,
            skills::skills_status,
            pty::pty_spawn,
            pty::pty_input,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // On app exit, kill embedded ptys so their `claude` children don't orphan
            // (which would keep the session "running" with no terminal after reopen).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                app_handle.state::<pty::PtyManager>().kill_all();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        category_root_dir, is_deletable_session_dir, is_pr_url, is_safe_branch, is_safe_category,
        is_safe_slug, is_ticket, is_valid_session_id, parse_usage, percent_encode, sanitize_session_name,
        set_frontmatter_links, slugify, stamp_archived, strip_archived, usage_view,
        validate_root_override,
    };
    use crate::reader;
    use serde_json::{json, Value};
    use std::path::PathBuf;

    #[test]
    fn valid_session_id_accepts_uuid_rejects_empty_and_metachars() {
        assert!(is_valid_session_id("b59fd8e8-fe1e-4ac5-bf6d-9a242a7f900f"));
        assert!(!is_valid_session_id(""));
        assert!(!is_valid_session_id("a b"));
        assert!(!is_valid_session_id("a;rm"));
        assert!(!is_valid_session_id("../x"));
    }

    #[test]
    fn safe_slug_accepts_folder_names_rejects_traversal_and_metachars() {
        assert!(is_safe_slug("my-slug"));
        assert!(is_safe_slug("GOSDK-123.hotfix_2")); // '.' allowed (folder names use it)
        assert!(!is_safe_slug("")); // empty
        assert!(!is_safe_slug("a/b")); // path separator
        assert!(!is_safe_slug("a b")); // space
        assert!(!is_safe_slug("a;rm")); // shell metachar (slug rides the skill prompt)
    }

    #[test]
    fn sanitize_session_name_collapses_filters_and_caps() {
        assert_eq!(sanitize_session_name("  Fix   the   bug  "), "Fix the bug"); // collapse+trim
        assert_eq!(sanitize_session_name("café résumé"), "café résumé"); // unicode letters kept
        assert_eq!(sanitize_session_name("rm -rf $HOME `id`"), "rm -rf HOME id"); // $, backtick dropped
        assert_eq!(sanitize_session_name("a\"b\\c"), "abc"); // quote + backslash dropped
        assert_eq!(sanitize_session_name(""), "");
        assert_eq!(sanitize_session_name(&"x".repeat(200)).chars().count(), 120); // capped
    }

    #[test]
    fn validate_root_override_requires_declared_and_safe() {
        let cfg = json!({ "roots": [{ "name": "Work", "path": "/w" }, { "name": "Perso", "path": "/p" }] });
        assert!(validate_root_override(&cfg, "").is_ok()); // empty = no override
        assert!(validate_root_override(&cfg, "Work").is_ok());
        assert!(validate_root_override(&cfg, "Ghost").is_err()); // not a declared root
        assert!(validate_root_override(&cfg, "a b").is_err()); // unsafe token
        assert!(validate_root_override(&cfg, &"x".repeat(31)).is_err()); // > 30 chars
    }

    #[test]
    fn deletable_session_dir_requires_two_levels_below_a_root() {
        let roots = vec![PathBuf::from("/Users/dev/work"), PathBuf::from("/Users/dev")];
        // A real session dir <root>/<CATEGORY>/<slug> → deletable.
        assert!(is_deletable_session_dir(&PathBuf::from("/Users/dev/work/FEAT/my-slug"), &roots));
        // The root itself → NEVER (would trash every session under it).
        assert!(!is_deletable_session_dir(&PathBuf::from("/Users/dev/work"), &roots));
        // A category dir <root>/<CATEGORY> → refused (one level).
        assert!(!is_deletable_session_dir(&PathBuf::from("/Users/dev/work/FEAT"), &roots));
        // Outside every root → refused.
        assert!(!is_deletable_session_dir(&PathBuf::from("/tmp/elsewhere/x/y"), &roots));
        // Deeper than a session dir is still fine (strictly-more-nested).
        assert!(is_deletable_session_dir(&PathBuf::from("/Users/dev/work/FEAT/slug/sub"), &roots));
    }

    #[test]
    fn slugify_is_byte_faithful_to_the_skill() {
        // Mirrors the skill's slug(): tr lower + sed 's/[^a-z0-9]+/-/g; trim -'.
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("  spaced  out  "), "spaced-out"); // runs collapse, ends trimmed
        assert_eq!(slugify("UPPER_case-123"), "upper-case-123");
        assert_eq!(slugify("Fix (bug) 2"), "fix-bug-2");
        // ASCII-only, like `sed` in the C locale: non-ASCII becomes a dash, NOT kept.
        // A Unicode-aware port (char::is_alphanumeric) would wrongly keep 'é' → "café".
        assert_eq!(slugify("My Café Session"), "my-caf-session");
        assert_eq!(slugify("réseau"), "r-seau");
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("---"), "");
    }

    #[test]
    fn category_root_dir_resolves_v2_root_then_falls_back_to_first_root() {
        let cfg = json!({
            "home": "/home/u",
            "roots": [{"name":"Work","path":"/w"},{"name":"Perso","path":"/p"},{"name":"Clients","path":"/c"}],
        });
        // v2: launch dir = the category's named root path.
        assert_eq!(category_root_dir(&cfg, &json!({"name":"X","root":"Clients"})), "/c");
        assert_eq!(category_root_dir(&cfg, &json!({"name":"X","root":"Perso"})), "/p");
        // Unknown root name → first root (v2 safety net).
        assert_eq!(category_root_dir(&cfg, &json!({"name":"X","root":"Ghost"})), "/w");
        // No root field → first root.
        assert_eq!(category_root_dir(&cfg, &json!({"name":"X"})), "/w");
        // Empty roots list → home.
        let cfg_no_roots = json!({
            "home": "/home/u",
            "roots": [],
        });
        assert_eq!(category_root_dir(&cfg_no_roots, &json!({"name":"X"})), "/home/u");
    }

    #[test]
    fn percent_encode_handles_multibyte_and_reserved() {
        assert_eq!(percent_encode("café"), "caf%C3%A9"); // multibyte UTF-8
        assert_eq!(percent_encode("a b/c"), "a%20b%2Fc"); // space + slash
        assert_eq!(percent_encode("AZ09-_.~"), "AZ09-_.~"); // unreserved pass through
    }

    const LINE: &str = "- 2026-06-14 10:00 | ARCHIVED | archived from the dashboard";

    #[test]
    fn strip_archived_removes_only_genuine_marker_lines() {
        // A pipe-delimited `| ARCHIVED |` entry is dropped; the rest is untouched.
        let content = "## Session history\n\
            - 2026-06-10 | session=abc | did stuff\n\
            - 2026-06-14 10:00 | ARCHIVED | archived from the dashboard\n\
            \n## Notes\nkeep me\n";
        let out = strip_archived(content);
        assert!(!out.contains("ARCHIVED"));
        assert!(out.contains("did stuff"));
        assert!(out.contains("keep me"));

        // Prose merely MENTIONING archived must survive (same guard as the reader).
        let prose = "## Session history\n- 2026-06-10 | session=abc | discussed the ARCHIVED marker\n";
        assert_eq!(strip_archived(prose), prose);

        // No marker at all → unchanged (idempotent, safe to call on every resume).
        let plain = "## Session history\n- 2026-06-10 | session=abc | did stuff\n";
        assert_eq!(strip_archived(plain), plain);
        // Idempotent: stripping twice equals stripping once.
        assert_eq!(strip_archived(&strip_archived(content)), strip_archived(content));
    }

    // ── Injection-boundary allowlists ──────────────────────────────────────────
    #[test]
    fn safe_category_accepts_tokens_rejects_metachars() {
        assert!(is_safe_category("FEAT"));
        assert!(is_safe_category("bug-fix_2"));
        assert!(!is_safe_category("")); // empty
        assert!(!is_safe_category(&"x".repeat(21))); // > 20 chars
        assert!(!is_safe_category("a b")); // space
        assert!(!is_safe_category("a;rm")); // shell metachar
        assert!(!is_safe_category("../x")); // path-traversal chars
        assert!(!is_safe_category("café")); // non-ASCII
    }

    #[test]
    fn ticket_accepts_project_keys_only() {
        assert!(is_ticket("ABC-123"));
        assert!(is_ticket("a1-9"));
        assert!(!is_ticket("ABC")); // no dash / number
        assert!(!is_ticket("-123")); // empty key
        assert!(!is_ticket("ABC-")); // empty number
        assert!(!is_ticket("1AB-2")); // key must start with a letter
        assert!(!is_ticket("AB C-2")); // space in key
        assert!(!is_ticket("ABC-12a")); // non-digit in number
    }

    #[test]
    fn safe_branch_blocks_flags_traversal_and_ref_syntax() {
        assert!(is_safe_branch("feat/checkout-redesign"));
        assert!(is_safe_branch("release/1.2.x"));
        assert!(!is_safe_branch("")); // empty
        assert!(!is_safe_branch("-delete")); // leading dash = flag smuggling
        assert!(!is_safe_branch("/abs")); // leading slash
        assert!(!is_safe_branch("trailing/")); // trailing slash
        assert!(!is_safe_branch("a..b")); // `..` revision range
        assert!(!is_safe_branch("HEAD@{1}")); // `@{` reflog syntax
        assert!(!is_safe_branch("a b")); // space
        assert!(!is_safe_branch("a;rm -rf")); // shell metachars
        assert!(!is_safe_branch(&"x".repeat(201))); // > 200 chars
    }

    #[test]
    fn pr_url_accepts_canonical_and_suffixed() {
        assert!(is_pr_url("https://github.com/owner/repo/pull/35"));
        assert!(is_pr_url("https://github.com/o/r/pull/1/files"));
        assert!(is_pr_url("https://github.com/o/r/pull/9#discussion_r1"));
        assert!(is_pr_url("https://github.com/o/r/pull/42?w=1"));
    }

    #[test]
    fn pr_url_rejects_non_pr_and_junk() {
        assert!(!is_pr_url("https://github.com/o/r/issues/3")); // not a PR
        assert!(!is_pr_url("https://github.com/o/r/pull/abc")); // no number
        assert!(!is_pr_url("https://github.com/o/r/pull/")); // missing number
        assert!(!is_pr_url("https://gitlab.com/o/r/pull/3")); // wrong host
        assert!(!is_pr_url("http://github.com/o/r/pull/3")); // not https
        assert!(!is_pr_url("https://github.com/o/r/pull/3 extra")); // whitespace
        assert!(!is_pr_url(""));
    }

    #[test]
    fn parse_usage_accepts_valid_object_rejects_garbage() {
        // Valid object → returns it.
        let obj = json!({ "model": "Opus 4.8", "fiveHourPct": 43 });
        let result = parse_usage(&obj.to_string());
        assert_eq!(result, obj);

        // Invalid/non-object JSON → Null.
        assert_eq!(parse_usage("garbage"), Value::Null);
        assert_eq!(parse_usage("42"), Value::Null); // scalar
        assert_eq!(parse_usage("[1,2,3]"), Value::Null); // array
        assert_eq!(parse_usage(""), Value::Null); // empty
        assert_eq!(parse_usage("null"), Value::Null); // null literal
    }

    const FM: &str = "---\nname: x\ncategory: REVIEW\nbranch: feat/y\n---\n\n# x\nbody\n";

    /// Helper: the PR-list write, which is the interesting instantiation.
    fn set_prs(content: &str, urls: &[&str]) -> String {
        let v: Vec<String> = urls.iter().map(|s| s.to_string()).collect();
        set_frontmatter_links(content, "pr_link", "pr_links", &v)
    }

    #[test]
    fn one_link_writes_the_primary_key_only() {
        let out = set_prs(FM, &["https://github.com/o/r/pull/5"]);
        assert!(out.contains("pr_link: https://github.com/o/r/pull/5"));
        assert!(!out.contains("pr_links:")); // no empty extras block
        // Other keys + body preserved, single frontmatter block.
        assert!(out.contains("category: REVIEW") && out.contains("# x\nbody"));
        assert_eq!(out.matches("\n---").count(), 1);
    }

    #[test]
    fn extra_links_go_to_the_plural_block() {
        let out = set_prs(FM, &["https://github.com/o/r/pull/5", "https://github.com/o/r/pull/9"]);
        assert!(out.contains("pr_link: https://github.com/o/r/pull/5"));
        assert!(out.contains("pr_links:\n  - https://github.com/o/r/pull/9"));
        // The reader reads back exactly what was written, in order.
        assert_eq!(
            reader::frontmatter_values(&out, "pr_link", "pr_links"),
            vec!["https://github.com/o/r/pull/5", "https://github.com/o/r/pull/9"]
        );
    }

    #[test]
    fn rewrite_replaces_the_whole_list_and_keeps_position() {
        let two = set_prs(FM, &["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
        // Back down to one → the extras block goes away entirely.
        let one = set_prs(&two, &["https://github.com/o/r/pull/2"]);
        assert!(one.contains("pr_link: https://github.com/o/r/pull/2"));
        assert!(!one.contains("pr_links:") && !one.contains("pull/1"));
        assert_eq!(one.matches("pr_link:").count(), 1);
        // The list stays where the primary key already sat (before `started_at`).
        let ordered = "---\nname: x\npr_link: https://github.com/o/r/pull/1\nstarted_at: t\n---\nbody";
        let out = set_prs(ordered, &["https://github.com/o/r/pull/3", "https://github.com/o/r/pull/4"]);
        assert!(out.contains("name: x\npr_link: https://github.com/o/r/pull/3\npr_links:\n  - https://github.com/o/r/pull/4\nstarted_at: t"));
    }

    #[test]
    fn empty_list_clears_both_keys() {
        let two = set_prs(FM, &["https://github.com/o/r/pull/1", "https://github.com/o/r/pull/2"]);
        let out = set_prs(&two, &[]);
        assert!(!out.contains("pr_link") && !out.contains("pull/"));
        assert!(out.contains("category: REVIEW")); // rest intact
        assert_eq!(out.matches("\n---").count(), 1);
    }

    #[test]
    fn tickets_use_the_same_writer() {
        let v = vec!["FEAT-1".to_string(), "FEAT-2".to_string()];
        let out = set_frontmatter_links(FM, "ticket", "tickets", &v);
        assert!(out.contains("ticket: FEAT-1\ntickets:\n  - FEAT-2"));
    }

    #[test]
    fn links_noop_without_frontmatter() {
        let plain = "# no frontmatter\nbody\n";
        assert_eq!(set_prs(plain, &["https://github.com/o/r/pull/1"]), plain);
    }

    #[test]
    fn appends_after_existing_history_entries() {
        let notes = "# Title\n\n## Session history\n- 2026-05-04 12:31 | session=abc | did stuff\n";
        let out = stamp_archived(notes, LINE);
        assert!(out.contains("did stuff"));
        assert!(out.contains("ARCHIVED"));
        // ARCHIVED comes after the existing entry, inside the section.
        assert!(out.find("did stuff").unwrap() < out.find("ARCHIVED").unwrap());
    }

    #[test]
    fn inserts_inside_section_when_history_is_not_last() {
        let notes = "## Session history\n- a | session=x\n\n## Next steps\n1. do\n";
        let out = stamp_archived(notes, LINE);
        // ARCHIVED must land before the next section header, not after it.
        assert!(out.find("ARCHIVED").unwrap() < out.find("## Next steps").unwrap());
        assert!(out.contains("## Next steps")); // section preserved
    }

    #[test]
    fn creates_section_when_absent() {
        let notes = "# Title\n\n## Goal\nstuff";
        let out = stamp_archived(notes, LINE);
        assert!(out.contains("## Session history"));
        assert!(out.contains("ARCHIVED"));
    }

    #[test]
    fn handles_empty_history_section() {
        let notes = "## Session history\n";
        let out = stamp_archived(notes, LINE);
        assert!(out.contains("ARCHIVED"));
    }

    #[test]
    fn usage_view_keyed_merges_global_and_session() {
        let cache = serde_json::json!({
            "global": { "fiveHourPct": 21, "sevenDayPct": 76, "fiveHourResetsAt": 1i64, "sevenDayResetsAt": 2i64, "updatedAt": 9i64 },
            "sessions": { "sid-1": { "model": "Opus 4.8", "contextPct": 42 } }
        });
        let v = usage_view(&cache, Some("sid-1"));
        assert_eq!(v["fiveHourPct"], 21);
        assert_eq!(v["sevenDayPct"], 76);
        assert_eq!(v["model"], "Opus 4.8");
        assert_eq!(v["contextPct"], 42);
    }

    #[test]
    fn usage_view_keyed_unknown_session_has_null_model_context() {
        let cache = serde_json::json!({
            "global": { "fiveHourPct": 21 },
            "sessions": { "sid-1": { "model": "Opus 4.8", "contextPct": 42 } }
        });
        let v = usage_view(&cache, Some("other"));
        assert_eq!(v["fiveHourPct"], 21);
        assert!(v["model"].is_null());
        assert!(v["contextPct"].is_null());
    }

    #[test]
    fn usage_view_legacy_flat_surfaces_model_only_without_session_id() {
        let cache = serde_json::json!({ "model": "Opus 4.8", "fiveHourPct": 5, "contextPct": 30 });
        // no session id → best-effort surface the flat model/context
        let none = usage_view(&cache, None);
        assert_eq!(none["fiveHourPct"], 5);
        assert_eq!(none["model"], "Opus 4.8");
        assert_eq!(none["contextPct"], 30);
        // a session id was requested but legacy has no per-session map → model/context null
        let with = usage_view(&cache, Some("sid-1"));
        assert_eq!(with["fiveHourPct"], 5);
        assert!(with["model"].is_null());
        assert!(with["contextPct"].is_null());
    }

    #[test]
    fn usage_view_non_object_is_null() {
        assert!(usage_view(&serde_json::Value::Null, None).is_null());
        assert!(usage_view(&serde_json::json!("x"), Some("s")).is_null());
    }
}
