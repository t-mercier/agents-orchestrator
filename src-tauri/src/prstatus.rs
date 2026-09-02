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

/// Fold one PR's fresh lookup into its cache entry.
///
/// `gh` is the parsed `gh pr view` output, or `None` when the lookup failed (a network
/// blip, a throttle, the wrong `gh` account active for a private repo). The rule that
/// matters is what happens on failure: a real `merged`/`open`/`closed` we already knew
/// must NOT be clobbered to `unknown` — that is how a correctly-synced PR suddenly reads
/// as un-synced after a Sync that happened to fail for it. On failure the previous state
/// and its `checkedAt` are kept untouched; only a lookup that actually answered advances
/// them. The title already followed this rule; the state now does too.
pub fn merge_pr_entry(previous: Option<&Value>, gh: Option<&Value>, now: &str) -> Value {
    let prev_str = |k: &str| previous.and_then(|e| e.get(k)).and_then(Value::as_str).map(String::from);
    let (state, checked_at) = match gh {
        Some(v) => (state_of(v).to_string(), now.to_string()),
        None => (
            prev_str("state").unwrap_or_else(|| "unknown".into()),
            prev_str("checkedAt").unwrap_or_default(),
        ),
    };
    let title = gh
        .and_then(|v| v.get("title"))
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| prev_str("title"))
        .unwrap_or_default();
    json!({ "state": state, "title": title, "checkedAt": checked_at })
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
    run_within(inner, CALL_TIMEOUT)
}

fn run_within(inner: &str, limit: Duration) -> Result<String, String> {
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
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out".into());
            }
        }
    }
}

/// Everything we know about the PRs, as `{url: {state, title, checkedAt}}`. Read at startup so
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
            "gh pr view {} --repo {} --json state,isDraft,title",
            crate::pty::shell_quote(&number),
            crate::pty::shell_quote(&repo),
        );
        let gh = run(&inner).ok().and_then(|out| serde_json::from_str::<Value>(&out).ok());
        let entry = merge_pr_entry(cache.get(&url), gh.as_ref(), &now);
        cache.insert(url, entry);
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

    #[test]
    fn a_successful_lookup_writes_the_fresh_state_title_and_time() {
        let prev = json!({"state": "open", "title": "old", "checkedAt": "yesterday"});
        let gh = json!({"state": "MERGED", "isDraft": false, "title": "new"});
        let out = merge_pr_entry(Some(&prev), Some(&gh), "today");
        assert_eq!(out["state"], "merged");
        assert_eq!(out["title"], "new");
        assert_eq!(out["checkedAt"], "today");
    }

    #[test]
    fn a_failed_lookup_keeps_the_known_state_and_its_timestamp() {
        // The bug this fixes: a merged PR whose lookup failed this Sync must not become
        // `unknown` and read as un-synced. State, title AND checkedAt all stay put —
        // nothing was actually re-checked, so the timestamp must not claim otherwise.
        let prev = json!({"state": "merged", "title": "the PR", "checkedAt": "yesterday"});
        let out = merge_pr_entry(Some(&prev), None, "today");
        assert_eq!(out["state"], "merged", "a known state is never clobbered to unknown");
        assert_eq!(out["title"], "the PR");
        assert_eq!(out["checkedAt"], "yesterday", "a failed lookup does not advance the time");
    }

    #[test]
    fn a_failed_lookup_on_a_brand_new_pr_is_honestly_unknown() {
        // No previous entry and the lookup failed → unknown is the truthful answer, and
        // the timestamp is empty since nothing was ever successfully checked.
        let out = merge_pr_entry(None, None, "today");
        assert_eq!(out["state"], "unknown");
        assert_eq!(out["title"], "");
        assert_eq!(out["checkedAt"], "");
    }

    #[test]
    fn a_failed_lookup_reuses_the_cached_title_even_with_no_prior_state() {
        // A half-populated entry (title known, state somehow absent) still yields the
        // title back rather than dropping it.
        let prev = json!({"title": "known title"});
        let out = merge_pr_entry(Some(&prev), None, "today");
        assert_eq!(out["title"], "known title");
        assert_eq!(out["state"], "unknown");
    }
}

/// An agent pass may read a tracker over the network and list several repositories; it is
/// slow by nature. The ceiling only exists so a hung run cannot leave Sync spinning.
const AGENT_TIMEOUT: Duration = Duration::from_secs(300);

/// Realign a session's tickets and PRs with reality, by asking an agent.
///
/// The app cannot do this itself and should not try: reading ticket statuses needs tracker
/// credentials it deliberately does not hold, and knowing which pull requests belong to a
/// session needs judgement about branch names. An agent has both, through MCP and `gh`, so
/// Sync runs `/sync-refs` headless and then re-reads the file.
///
/// No `--resume`: this needs the session's *frontmatter*, not its conversation, so loading
/// a transcript would cost a great deal to learn nothing.
#[tauri::command(async)]
pub fn sync_refs(notes_path: String, cwd: String) -> Result<Value, String> {
    let abs = crate::notes_md_under_root(&notes_path)?;
    let dir = if std::path::Path::new(&cwd).is_dir() {
        cwd
    } else {
        crate::config::home().to_string_lossy().to_string()
    };
    let inner = format!(
        "cd {} && claude --model {} --permission-mode acceptEdits -p {}",
        crate::pty::shell_quote(&dir),
        crate::pty::shell_quote(crate::pty::CLAUDE_MODEL),
        crate::pty::shell_quote(&format!("/sync-refs {}", abs.display())),
    );
    let out = run_within(&inner, AGENT_TIMEOUT)?;
    // Read the PR list back from the file the agent just rewrote, rather than making the
    // renderer wait a guessed number of milliseconds for its own reload to land. The
    // caller needs the complete list to ask gh for each state.
    let prs = std::fs::read_to_string(&abs)
        .map(|c| crate::reader::frontmatter_values(&c, "pr_link", "pr_links"))
        .unwrap_or_default();
    // The skill's confirmation is one line by contract; keep the last one in case the
    // shell printed anything ahead of it.
    let summary = out.lines().last().unwrap_or("Synced.").trim().to_string();
    Ok(json!({ "summary": summary, "prs": prs }))
}
