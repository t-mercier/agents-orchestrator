//! Pull-request state (open / merged / closed / draft) for the sessions' PR links.
//!
//! The app makes no network calls on its own: this module runs only when the user
//! presses **Sync**. There is no timer and no Settings toggle — the button *is* the
//! opt-in, which keeps the promise honest ("zero network until you press Sync") without
//! a preference anyone can forget having enabled.
//!
//! State is cached in its own file rather than in the session's notes.md: the frontmatter
//! belongs to the user and the session skills, and a value that goes stale on its own has
//! no business living there.

use serde_json::{json, Map, Value};
use std::time::{Duration, Instant};

/// One `gh` call may hang on a slow network; a Sync over a handful of PRs must not.
const CALL_TIMEOUT: Duration = Duration::from_secs(15);

fn cache_path() -> std::path::PathBuf {
    crate::config::config_dir().join("pr-status.json")
}

/// `https://github.com/owner/repo/pull/12` → `("owner/repo", "12")`.
/// Anything else (a wrong host, a missing number) → None, so a bad link is skipped
/// rather than turned into a `gh` call that cannot mean anything.
pub fn parse_pr_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://github.com/")?;
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?;
    if parts.next()? != "pull" {
        return None;
    }
    // Trailing `/files`, `#discussion`, `?w=1` are all fine — take the leading digits.
    let number: String = parts.next()?.chars().take_while(|c| c.is_ascii_digit()).collect();
    if number.is_empty() || owner.contains('.') && owner.starts_with('.') {
        return None;
    }
    Some((format!("{owner}/{repo}"), number))
}

/// `gh`'s two fields folded into the one word the UI shows. `state` stays OPEN while a
/// PR is a draft, so `isDraft` — not `state` — is what separates those two.
pub fn state_of(gh: &Value) -> &'static str {
    if gh.get("isDraft").and_then(Value::as_bool).unwrap_or(false) {
        return "draft";
    }
    match gh.get("state").and_then(Value::as_str).unwrap_or("") {
        "OPEN" => "open",
        "MERGED" => "merged",
        "CLOSED" => "closed",
        _ => "unknown",
    }
}

/// Run a command through a login shell and return its stdout.
///
/// The login shell is not optional: launched from Finder the app inherits a bare PATH,
/// and `gh` is typically installed by a version manager (mise, asdf, homebrew) that only
/// a sourced profile puts on the path.
fn run(inner: &str) -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut child = std::process::Command::new(&shell)
        .args(["-ilc", inner])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                return if status.success() {
                    Ok(text)
                } else {
                    Err(format!("command failed: {inner}"))
                };
            }
            Ok(None) if start.elapsed() < CALL_TIMEOUT => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".into());
            }
        }
    }
}

/// Everything we know about the PRs, as `{url: {state, checkedAt}}`. Read at startup so
/// the marks are coloured before the first Sync of the session; an absent or corrupt
/// cache is simply an empty map (every PR then reads as `unknown`, which is honest).
#[tauri::command(async)]
pub fn get_pr_status() -> Value {
    std::fs::read_to_string(cache_path())
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

/// Ask GitHub about each URL and merge the answers into the cache.
///
/// Failures are per-PR: a deleted PR or a repo you have lost access to leaves that one
/// `unknown` and does not sink the others. Only a missing or unauthenticated `gh` fails
/// the whole call, because that is one thing to fix, not N.
#[tauri::command(async)]
pub fn sync_pr_status(urls: Vec<String>) -> Result<Value, String> {
    if run("command -v gh").is_err() {
        return Err("GitHub CLI (gh) not found. Install it to sync pull-request state.".into());
    }
    if run("gh auth status").is_err() {
        return Err("gh is not logged in. Run `gh auth login`, then sync again.".into());
    }
    let now = crate::local_date_time()
        .map(|(d, t)| format!("{d} {t}"))
        .unwrap_or_default();

    let mut cache = match get_pr_status() {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    for url in urls {
        let Some((repo, number)) = parse_pr_url(&url) else { continue };
        let inner = format!(
            "gh pr view {} --repo {} --json state,isDraft",
            crate::pty::shell_quote(&number),
            crate::pty::shell_quote(&repo),
        );
        let state = run(&inner)
            .ok()
            .and_then(|out| serde_json::from_str::<Value>(&out).ok())
            .map(|v| state_of(&v))
            .unwrap_or("unknown");
        cache.insert(url, json!({ "state": state, "checkedAt": now }));
    }
    let body = Value::Object(cache);
    // Best-effort: a cache we could not persist still gets returned, so this Sync works
    // even when the config dir is read-only.
    if let Ok(text) = serde_json::to_string_pretty(&body) {
        let _ = std::fs::create_dir_all(crate::config::config_dir());
        let _ = crate::atomic_write(&cache_path(), &text);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_pr_url() {
        assert_eq!(
            parse_pr_url("https://github.com/tomtom-internal/mapdisplay-for-unity/pull/5107"),
            Some(("tomtom-internal/mapdisplay-for-unity".into(), "5107".into()))
        );
    }

    #[test]
    fn parses_urls_with_a_suffix() {
        for u in [
            "https://github.com/o/r/pull/12/files",
            "https://github.com/o/r/pull/12#discussion_r1",
            "https://github.com/o/r/pull/12?w=1",
        ] {
            assert_eq!(parse_pr_url(u), Some(("o/r".into(), "12".into())), "{u}");
        }
    }

    #[test]
    fn rejects_what_is_not_a_pr_url() {
        for u in [
            "http://github.com/o/r/pull/12",      // not https
            "https://gitlab.com/o/r/pull/12",     // wrong host
            "https://github.com/o/r/issues/12",   // not a PR
            "https://github.com/o/r/pull/abc",    // no number
            "https://github.com/o/r/pull/",       // missing number
            "https://github.com/o/pull/12",       // no repo segment
        ] {
            assert_eq!(parse_pr_url(u), None, "{u}");
        }
    }

    #[test]
    fn maps_gh_output_to_a_state() {
        let cases = [
            (json!({"state": "OPEN",   "isDraft": false}), "open"),
            (json!({"state": "OPEN",   "isDraft": true}),  "draft"),
            (json!({"state": "MERGED", "isDraft": false}), "merged"),
            (json!({"state": "CLOSED", "isDraft": false}), "closed"),
            (json!({"state": "WAT",    "isDraft": false}), "unknown"),
            (json!({}), "unknown"),
        ];
        for (input, want) in cases {
            assert_eq!(state_of(&input), want, "{input}");
        }
    }

    /// A merged PR is reported by gh as MERGED with isDraft false — but a draft that was
    /// closed keeps isDraft true, and "draft" is the more useful thing to show.
    #[test]
    fn draft_wins_over_state() {
        assert_eq!(state_of(&json!({"state": "CLOSED", "isDraft": true})), "draft");
    }
}
