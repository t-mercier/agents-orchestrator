//! Read-only projection of ~/.claude (port of data/reader.js).
//! Running sessions (sessions/*.json + active-sessions.json) + historical
//! sessions (notes.md scan). Transcript-derived fields come with the terminal pass.
use crate::config::home;
use crate::git;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime};

// Transcript fold cache, keyed by sessionId and validated by the file's (len, mtime).
// The poll re-reads transcripts every 5s; for idle/historical sessions the file is
// unchanged so this returns the cached fold (and skips the projects-dir scan too).
// A running session appends, so its (len/mtime) changes and it re-reads — but those
// are few vs the many static historical transcripts that dominated the cost.
type TranscriptEntry = (PathBuf, u64, Option<SystemTime>, Transcript);
static TRANSCRIPT_CACHE: LazyLock<Mutex<HashMap<String, TranscriptEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

use crate::{is_safe_slug, is_valid_session_id};

/// Mirror of isProcessAlive: alive if kill(pid,0) succeeds, or EPERM (exists but
/// we can't signal it).
fn alive(pid: i64) -> bool {
    // The pid comes from a sessions/*.json written by another process — clamp it to
    // pid_t's range before the cast. An oversized value would wrap negative, and
    // kill(-pgid, 0) queries a whole PROCESS GROUP: a dead session could then read
    // as alive because some unrelated group member answered.
    if pid <= 0 || pid > libc::pid_t::MAX as i64 {
        return false;
    }
    unsafe {
        if libc::kill(pid as libc::pid_t, 0) == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}


/// Fields pulled from a session's transcript (jsonl). The transcript is the
/// source of truth for where a session actually works + its branch + last reply.
#[derive(Default, Clone)]
struct Transcript {
    git_branch: Option<String>,
    pr_link: Option<String>,
    // Every GitHub PR URL pasted into the conversation (with duplicates, so the
    // picker can break ties by frequency). REVIEW sessions get their PR link from
    // here when the frontmatter has none — you paste it to ask Claude to review.
    pr_urls: Vec<String>,
    last_activity: Option<String>,
    last_activity_at: Option<String>,
    // Last cwd seen — where the session was working most recently (used for the
    // live git branch/worktree on running sessions).
    cwd: Option<String>,
    // First cwd seen — the directory `claude` was launched from. Claude Code keys
    // `--resume` by this directory, so it's what a resume must cd into (a session
    // that cd'd into a subdir mid-run still resumes from its launch dir).
    launch_cwd: Option<String>,
    // Whether the transcript .jsonl was actually found+read. A closed/archived
    // session whose transcript was deleted/rotated CANNOT be `--resume`d (the
    // conversation no longer exists anywhere) — only `/restart-session`ed from notes.
    found: bool,
    // Last-modified time of the transcript file — used to detect a session that was
    // reopened (resumed) and worked on after its last /close-session (transcript touched on a
    // later day) → reclassify closed → stale.
    mtime: Option<SystemTime>,
}

/// Parse ~/.claude/active-sessions.json (the skills' session registry). `{}` when
/// absent or unparseable — every consumer treats the registry as best-effort. The one
/// place the file is read+parsed (it was inlined four times, incl. once per notes.md
/// inside the poll scan).
fn load_active_sessions() -> Value {
    fs::read_to_string(home().join(".claude").join("active-sessions.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

/// All GitHub PR URLs in raw transcript text (with duplicates, so the picker can use
/// frequency). Scans for the `https://github.com/` needle + validates the `/pull/<n>`
/// shape — the user pastes the PR link when asking Claude to review it.
fn extract_pr_urls(text: &str) -> Vec<String> {
    const NEEDLE: &str = "https://github.com/";
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(rel) = text[from..].find(NEEDLE) {
        let start = from + rel;
        let tail = &text[start..];
        let end = tail
            .find(|c: char| {
                c.is_whitespace()
                    || matches!(c, '"' | '\'' | '\\' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>' | '|' | '`')
            })
            .unwrap_or(tail.len());
        let url = tail[..end].trim_end_matches(['.', ',', ';', ':', '!']);
        if pull_number(url).is_some() {
            out.push(url.to_string());
        }
        from = start + NEEDLE.len();
    }
    out
}

/// The PR number of a `…/pull/<n>…` URL (leading digits after `/pull/`), if any.
fn pull_number(url: &str) -> Option<&str> {
    let after = url.split("/pull/").nth(1)?;
    let end = after.find(|c: char| !c.is_ascii_digit()).unwrap_or(after.len());
    (end > 0).then_some(&after[..end])
}

/// True if `n` appears as a standalone number in `name` ("(PR 35)" matches "35",
/// not "350").
fn name_has_number(name: &str, n: &str) -> bool {
    name.split(|c: char| !c.is_ascii_digit()).any(|tok| tok == n)
}

/// Pick a session's PR URL: prefer one whose number also appears in the name (so the
/// reviewed PR wins over others mentioned in the conversation), else most frequent.
fn pick_pr_url(urls: &[String], name: &str) -> Option<String> {
    for u in urls {
        if pull_number(u).is_some_and(|n| name_has_number(name, n)) {
            return Some(u.clone());
        }
    }
    let mut best: Option<(&String, usize)> = None;
    for u in urls {
        let c = urls.iter().filter(|x| x.as_str() == u.as_str()).count();
        if best.as_ref().is_none_or(|(_, bc)| c > *bc) {
            best = Some((u, c));
        }
    }
    best.map(|(u, _)| u.clone())
}

/// Read ~/.claude/projects/*/<sid>.jsonl (located by scanning project dirs, which
/// avoids the lossy cwd→folder encoding) and fold the events into the last seen
/// gitBranch / prLink / cwd and the last assistant text.
fn read_transcript(sid: &str) -> Transcript {
    // Allowlist the sid before it builds a file path (`{sid}.jsonl`). Most callers
    // already validate, but get_sessions() folds the sid straight from a
    // sessions/*.json written by another process — a `..`-laden sid would otherwise
    // let read_dir + join escape ~/.claude/projects. Guarding here covers every caller
    // in one place (matches resolve_session_cwd / resolve_slug_cwd).
    if !is_valid_session_id(sid) {
        return Transcript::default();
    }
    // Cache hit: cached path still exists and its (len, mtime) is unchanged. This
    // also skips the projects-dir scan below.
    if let Some((path, len, mtime, tr)) = TRANSCRIPT_CACHE.lock().unwrap().get(sid) {
        if let Ok(meta) = fs::metadata(path) {
            if meta.len() == *len && meta.modified().ok() == *mtime {
                return tr.clone();
            }
        }
    }

    let mut t = Transcript::default();
    // KNOWN OVERHEAD (audit, deferred): a miss below is not cached, so every poll
    // re-runs this read_dir + per-subdir stat for each sid whose .jsonl is gone
    // (rotated/deleted historical sessions). Measured cost is small (one dir scan,
    // VFS-cached), so it's left as-is. If it ever matters, the fix is a per-poll
    // sid→path index built once (one read_dir, one pass) — NOT a TTL negative cache,
    // which would hide a transcript that appears mid-session for up to the TTL.
    let projects = home().join(".claude").join("projects");
    let dirs = match fs::read_dir(&projects) {
        Ok(d) => d,
        Err(_) => return t,
    };
    let mut path = None;
    for d in dirs.flatten() {
        let p = d.path().join(format!("{sid}.jsonl"));
        if p.is_file() {
            path = Some(p);
            break;
        }
    }
    let path = match path {
        Some(p) => p,
        None => return t,
    };
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return t,
    };
    t.found = true;
    t.pr_urls = extract_pr_urls(&content);
    for line in content.lines() {
        if line.is_empty() {
            continue;
        }
        let ev: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(b) = ev.get("gitBranch").and_then(Value::as_str) {
            t.git_branch = Some(b.to_string());
        }
        if let Some(pr) = ev.get("prLink").and_then(Value::as_str) {
            t.pr_link = Some(pr.to_string());
        }
        if let Some(c) = ev.get("cwd").and_then(Value::as_str) {
            if t.launch_cwd.is_none() {
                t.launch_cwd = Some(c.to_string()); // first = launch dir (resume key)
            }
            t.cwd = Some(c.to_string()); // last = current work dir (git info)
        }
        if ev.get("type").and_then(Value::as_str) == Some("assistant") {
            // Collect all text blocks from this assistant message
            let blocks: Vec<&str> = ev
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|c| c.get("text").and_then(Value::as_str))
                        .collect()
                })
                .unwrap_or_default();
            // Extract the last meaningful block (not the first), cleaning markdown
            if let Some(last_block) = extract_last_activity_block(&blocks) {
                t.last_activity = Some(last_block.chars().take(200).collect());
                t.last_activity_at = ev.get("timestamp").and_then(Value::as_str).map(String::from);
            }
        }
    }

    // Cache the fold, keyed by the file's current (len, mtime).
    let meta = fs::metadata(&path).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta.and_then(|m| m.modified().ok());
    t.mtime = mtime;
    TRANSCRIPT_CACHE
        .lock()
        .unwrap()
        .insert(sid.to_string(), (path, len, mtime, t.clone()));
    t
}

/// The directory `claude` was launched from for a session — what `--resume` and
/// `/restart-session` must cd into (Claude Code keys resume by launch dir). Mirrors the
/// Electron resolveSessionCwd (which returned the transcript's first cwd).
pub fn resolve_session_cwd(sid: &str) -> Option<String> {
    if !is_valid_session_id(sid) {
        return None;
    }
    read_transcript(sid).launch_cwd
}

/// Fall-back launch dir for a slug when its transcript cwd is gone (closed/archived
/// sessions usually have no live transcript): find its `notes.md` under a configured
/// scanDir and return that SPACE's root — the scanDir base's parent, i.e. `<space>` in
/// `<space>/<CATEGORY>/<slug>`. So a Work session restarts in Work, not in $HOME.
pub fn resolve_slug_cwd(slug: &str) -> Option<String> {
    if !is_safe_slug(slug) {
        return None;
    }
    let cfg = crate::config::load();
    let dirs = cfg.get("scanDirs").and_then(Value::as_array)?;
    for sd in dirs {
        let base = match sd.get("base").and_then(Value::as_str) {
            Some(b) => b,
            None => continue,
        };
        if std::path::Path::new(base).join(slug).join("notes.md").is_file() {
            return std::path::Path::new(base)
                .parent()
                .map(|p| p.to_string_lossy().into_owned());
        }
    }
    None
}

/// Claude Code prepends machine context to the first user turn — skill bodies,
/// slash-command echoes, system reminders, CLAUDE.md dumps, tool results. None of
/// those make a useful session title, so skip them and take the first genuine prompt.
fn is_title_noise(s: &str) -> bool {
    let t = s.trim_start();
    t.is_empty()
        || t.starts_with('<') // <command-name> / <system-reminder> / <local-command-stdout> …
        || t.starts_with("Caveat:")
        || t.starts_with("Base directory for this skill")
        || t.starts_with("Contents of ")
        || t.to_lowercase().contains("system-reminder")
}

/// A transcript's title + launch dir + whether to skip it. The title is the first
/// genuine user prompt (past the injected noise above); `skip` is set for transcripts
/// that aren't real interactive sessions — slash-command / skill one-off runs (the
/// first user turn carries `<command-name>` markup) and sub-agent sidechains. Iterator-
/// based + early-return so we don't load a huge .jsonl just for the header.
fn discover_meta_lines<I: Iterator<Item = String>>(lines: I) -> (Option<String>, Option<String>, bool) {
    let mut title: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut skip = false;
    let mut seen_user = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let ev: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if ev.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            skip = true; // sub-agent transcript, not a user session
        }
        if cwd.is_none() {
            if let Some(c) = ev.get("cwd").and_then(Value::as_str) {
                cwd = Some(c.to_string());
            }
        }
        if ev.get("type").and_then(Value::as_str) == Some("user") {
            let content = ev.get("message").and_then(|m| m.get("content"));
            // A user turn can be a string or an array of blocks; the real prompt may
            // sit AFTER an injected block, so scan all text for the first non-noise one.
            let texts: Vec<&str> = match content {
                Some(Value::String(s)) => vec![s.as_str()],
                Some(Value::Array(arr)) => arr
                    .iter()
                    .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|c| c.get("text").and_then(Value::as_str))
                    .collect(),
                _ => Vec::new(),
            };
            // The first user turn of a slash-command / skill run carries the command
            // markup → it's a one-off, not a session to import.
            if !seen_user {
                seen_user = true;
                if texts.iter().any(|t| t.contains("<command-name>") || t.contains("<command-message>")) {
                    skip = true;
                }
            }
            if title.is_none() {
                if let Some(t) = texts.into_iter().map(str::trim).find(|t| !is_title_noise(t)) {
                    title = Some(t.chars().take(100).collect());
                }
            }
        }
        if title.is_some() && cwd.is_some() && seen_user {
            break;
        }
    }
    (title, cwd, skip)
}

fn discover_meta(path: &std::path::Path) -> (Option<String>, Option<String>, bool) {
    use std::io::{BufRead, BufReader};
    match fs::File::open(path) {
        Ok(f) => discover_meta_lines(BufReader::new(f).lines().map_while(Result::ok)),
        Err(_) => (None, None, false),
    }
}

/// sessionIds the app already manages — registered in active-sessions.json OR carried
/// in a notes.md frontmatter under the configured roots (covers running/closed/archived).
/// Used to exclude already-managed transcripts from the import picker.
fn managed_session_ids() -> HashSet<String> {
    let mut ids = HashSet::new();
    if let Value::Object(m) = load_active_sessions() {
        ids.extend(m.into_iter().map(|(k, _)| k));
    }
    let cfg = crate::config::load();
    if let Some(dirs) = cfg.get("scanDirs").and_then(Value::as_array) {
        for sd in dirs {
            let base = match sd.get("base").and_then(Value::as_str) {
                Some(b) => b,
                None => continue,
            };
            if let Ok(entries) = fs::read_dir(base) {
                for e in entries.flatten() {
                    if let Ok(c) = fs::read_to_string(e.path().join("notes.md")) {
                        if let Some(sid) = parse_frontmatter(&c).get("session_id") {
                            ids.insert(sid.clone());
                        }
                    }
                }
            }
        }
    }
    ids
}

/// Pure core of `discover_sessions`: drop managed and skip=true rows, sort newest-first
/// by mtime, cap to the 30 newest. Rows are (mtime, sessionId, title, cwd, skip).
fn select_unmanaged(
    rows: Vec<(u64, String, Option<String>, Option<String>, bool)>,
    managed: &std::collections::HashSet<String>,
) -> Vec<Value> {
    let mut kept: Vec<(u64, Value)> = rows
        .into_iter()
        .filter(|(_, sid, _, _, skip)| !skip && !managed.contains(sid))
        .map(|(mtime, sid, title, cwd, _)| {
            (mtime, json!({ "sessionId": sid, "title": title, "cwd": cwd, "mtime": mtime }))
        })
        .collect();
    kept.sort_by_key(|(mtime, _)| std::cmp::Reverse(*mtime));
    kept.into_iter().take(30).map(|(_, v)| v).collect()
}

/// The most-recent *unmanaged* Claude Code transcripts (`~/.claude/projects/**/<id>.jsonl`
/// with no managing notes.md) — fuel for the "Import a session" picker. Capped to the
/// 30 newest by mtime (the picker is for recent work; older ones aren't the use case).
#[tauri::command(async)]
pub fn discover_sessions() -> Vec<Value> {
    let projects = home().join(".claude").join("projects");
    let managed = managed_session_ids();
    let mut rows: Vec<(u64, String, Option<String>, Option<String>, bool)> = Vec::new();
    let dirs = match fs::read_dir(&projects) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    for d in dirs.flatten() {
        let pdir = d.path();
        if !pdir.is_dir() {
            continue;
        }
        let files = match fs::read_dir(&pdir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let sid = match path.file_stem().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let mtime = fs::metadata(&path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let (title, cwd, skip) = discover_meta(&path);
            rows.push((mtime, sid, title, cwd, skip));
        }
    }
    select_unmanaged(rows, &managed)
}

/// Extract a markdown section body: text between "## <heading>\n" and the next "## ".
fn extract_section(content: &str, heading: &str) -> Option<String> {
    let marker = format!("## {heading}\n");
    let start = content.find(&marker)? + marker.len();
    let rest = &content[start..];
    let end = rest.find("\n## ").unwrap_or(rest.len());
    let body = rest[..end].trim();
    if body.is_empty() {
        None
    } else {
        Some(body.to_string())
    }
}

// (goal, next_steps, pr_link) read from a running session's notes.md. pr_link comes
// from the frontmatter — the durable source — and the caller prefers it over the
// (vestigial) transcript prLink.
fn read_notes_meta(notes_path: &str) -> (Value, Value, Value, Value) {
    match fs::read_to_string(notes_path) {
        Ok(c) => {
            let pr_link = parse_frontmatter(&c)
                .get("pr_link")
                .filter(|s| !s.is_empty())
                .map(|s| Value::String(s.clone()))
                .unwrap_or(Value::Null);
            (
                extract_section(&c, "Goal").map(Value::String).unwrap_or(Value::Null),
                extract_section(&c, "Next steps").map(Value::String).unwrap_or(Value::Null),
                pr_link,
                last_history_summary(&c).map(Value::String).unwrap_or(Value::Null),
            )
        }
        Err(_) => (Value::Null, Value::Null, Value::Null, Value::Null),
    }
}

/// (running sids, their notes_paths) — a CHEAP scan for the historical-tab exclusion:
/// reads sessions/*.json (sid + non-bg + alive pid) and active-sessions.json only,
/// with NO transcript reads or git spawns (unlike get_sessions, which this replaces
/// inside get_historical_sessions).
fn running_session_ids() -> (HashSet<String>, HashSet<String>) {
    let claude = home().join(".claude");
    let active = load_active_sessions();
    let mut ids = HashSet::new();
    let mut notes = HashSet::new();
    let entries = match fs::read_dir(claude.join("sessions")) {
        Ok(e) => e,
        Err(_) => return (ids, notes),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let data: Value = match fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(d) => d,
            None => continue,
        };
        if data.get("kind").and_then(Value::as_str) == Some("bg") {
            continue;
        }
        if !alive(data.get("pid").and_then(Value::as_i64).unwrap_or(0)) {
            continue;
        }
        if let Some(sid) = data.get("sessionId").and_then(Value::as_str) {
            if let Some(np) = active.get(sid).and_then(|m| m.get("notes_path")).and_then(Value::as_str) {
                notes.insert(np.to_string());
            }
            ids.insert(sid.to_string());
        }
    }
    (ids, notes)
}

/// The root name a notes.md belongs to, matched by the longest scanDir `base` it
/// sits under. Null when no configured root contains it (e.g. an ad-hoc session
/// outside every root) — the renderer treats Null as "shown under every root".
fn root_for_notes_path(cfg: &Value, notes_path: &str) -> Value {
    let mut best: Option<(usize, Value)> = None;
    if let Some(dirs) = cfg.get("scanDirs").and_then(Value::as_array) {
        for sd in dirs {
            if let Some(base) = sd.get("base").and_then(Value::as_str) {
                // Component-aware: `/w/FEAT` must NOT match `/w/FEAT-bug/…`. A plain
                // string prefix would (mirrors notes_md_under_root in lib.rs).
                if std::path::Path::new(notes_path).starts_with(base)
                    && best.as_ref().map(|(l, _)| base.len() > *l).unwrap_or(true)
                {
                    best = Some((base.len(), sd.get("root").cloned().unwrap_or(Value::Null)));
                }
            }
        }
    }
    best.map(|(_, r)| r).unwrap_or(Value::Null)
}

/// PR link for a session: explicit frontmatter wins; else (REVIEW only) the PR URL
/// pasted into the transcript, disambiguated by the number in the session name.
/// Shared by get_sessions (owned Transcript) and scan_historical (Option<Transcript>);
/// callers pass the pr_urls slice (empty when there is no transcript).
fn resolve_pr_link(explicit_fm: Value, category: &str, pr_urls: &[String], name: &str) -> Value {
    if !explicit_fm.is_null() {
        explicit_fm
    } else if category == "REVIEW" {
        pick_pr_url(pr_urls, name).map(Value::String).unwrap_or(Value::Null)
    } else {
        Value::Null
    }
}

#[tauri::command(async)]
pub fn get_sessions() -> Vec<Value> {
    let claude = home().join(".claude");
    let cfg = crate::config::load();
    let active = load_active_sessions();

    let mut out = Vec::new();
    let entries = match fs::read_dir(claude.join("sessions")) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let data: Value = match fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(d) => d,
            None => continue,
        };
        let sid = match data.get("sessionId").and_then(Value::as_str) {
            Some(s) => s.to_string(),
            None => continue,
        };
        // Skip Claude Code background jobs (kind:"bg") and dead processes.
        if data.get("kind").and_then(Value::as_str) == Some("bg") {
            continue;
        }
        let pid = data.get("pid").and_then(Value::as_i64).unwrap_or(0);
        if !alive(pid) {
            continue;
        }

        let entry_meta = active.get(&sid).cloned().unwrap_or_else(|| json!({}));
        let notes_path = entry_meta.get("notes_path").and_then(Value::as_str).map(String::from);
        let (goal, next_steps, pr_link_fm, last_summary) = match &notes_path {
            Some(p) => read_notes_meta(p),
            None => (Value::Null, Value::Null, Value::Null, Value::Null),
        };
        let launch_cwd = data.get("cwd").and_then(Value::as_str).unwrap_or("");
        // The transcript records where the session actually works (it cd's into a
        // repo/worktree); the launch cwd is just where `claude` started. Use the
        // transcript's latest cwd for the live git worktree + branch, and pull the
        // last activity / PR link from it too.
        let tr = read_transcript(&sid);
        let work_cwd = tr.cwd.clone().unwrap_or_else(|| launch_cwd.to_string());
        let (branch_git, worktree) = git::git_info(&work_cwd);
        let git_branch = if branch_git.is_null() {
            tr.git_branch.map(Value::String).unwrap_or(Value::Null)
        } else {
            branch_git
        };

        // PR link: explicit frontmatter wins; else (REVIEW only) the PR URL pasted
        // into the transcript, disambiguated by the number in the session name.
        let category = entry_meta.get("category").and_then(Value::as_str).unwrap_or("");
        let name_str = data.get("name").and_then(Value::as_str).unwrap_or("");
        let pr_link = resolve_pr_link(pr_link_fm, category, &tr.pr_urls, name_str);

        let root = notes_path
            .as_deref()
            .map(|p| root_for_notes_path(&cfg, p))
            .unwrap_or(Value::Null);

        // Claude Code's pidfile `status` can lag — it stays `idle` while the main loop is
        // actually working (the dashboard then shows a green/idle dot on a busy session).
        // A transcript touched in the last few seconds means live output, so override a
        // stale `idle` with `busy`. Leave `waiting` (needs-you) and `shell` untouched —
        // those are meaningful signals, not lag.
        let status_raw = data.get("status").and_then(Value::as_str).unwrap_or("idle");
        let recently_active =
            tr.mtime.and_then(|m| m.elapsed().ok()).is_some_and(|e| e.as_secs() < 10);
        let status = if status_raw == "idle" && recently_active { "busy" } else { status_raw };

        out.push(json!({
            "sessionId": sid,
            // Prefer the registered name (active-sessions.json, set by /start-session's
            // rename) — same source as category/ticket below. Claude Code often leaves the
            // pidfile `name` empty, which showed managed sessions as "unnamed". Fall back to
            // the pidfile title for unmanaged live sessions.
            "name": entry_meta.get("name").and_then(Value::as_str).filter(|s| !s.is_empty())
                .or_else(|| data.get("name").and_then(Value::as_str))
                .unwrap_or(""),
            "cwd": launch_cwd,
            "pid": pid,
            "status": status,
            // "cli" (Claude Code terminal) or "claude-desktop" (the Claude Desktop app) —
            // lets an unmanaged claude-desktop session group as "Claude Desktop" in the
            // renderer instead of falling into the catch-all "OTHER".
            "entrypoint": data.get("entrypoint").and_then(Value::as_str).unwrap_or(""),
            "state": "active",   // lifecycle state: live pid (vs stale/closed/archived)
            "updatedAt": data.get("updatedAt").cloned().unwrap_or(Value::Null),
            "notesPath": notes_path,
            "root": root,
            "category": entry_meta.get("category").cloned().unwrap_or(Value::Null),
            "ticket": entry_meta.get("ticket").cloned().unwrap_or(Value::Null),
            "goal": goal,
            "nextSteps": next_steps,
            "gitBranch": git_branch,
            "worktree": worktree,
            "lastActivity": tr.last_activity.map(Value::String).unwrap_or(Value::Null),
            "lastActivityAt": tr.last_activity_at.map(Value::String).unwrap_or(Value::Null),
            "lastSummary": last_summary,
            "prLink": pr_link,
        }));
    }

    // Recover identity for LIVE sessions that aren't in active-sessions.json — e.g. an
    // archived/closed session resumed directly. The Running tab keys category/notes/root
    // off active-sessions, so without this they'd show uncategorised ("OTHER") with no
    // workspace. The notes.md records the live id in its history, so relink via that.
    // Only scans when something is actually unregistered → the common poll pays nothing.
    let needs_recovery =
        |s: &Value| s.get("category").and_then(Value::as_str).is_none_or(str::is_empty);
    let missing: HashSet<String> = out
        .iter()
        .filter(|s| needs_recovery(s))
        .filter_map(|s| s.get("sessionId").and_then(Value::as_str).map(String::from))
        .collect();
    if !missing.is_empty() {
        let recovered = recover_unregistered(&cfg, &missing);
        for s in out.iter_mut() {
            if !needs_recovery(s) {
                continue;
            }
            let sid = s.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
            if let Some(meta) = recovered.get(&sid) {
                s["category"] = meta["category"].clone();
                s["ticket"] = meta["ticket"].clone();
                s["notesPath"] = meta["notesPath"].clone();
                s["root"] = meta["root"].clone();
                if s.get("name").and_then(Value::as_str).unwrap_or("").is_empty() {
                    s["name"] = meta["name"].clone();
                }
            }
        }
    }
    out
}

/// Does this notes.md record `session=<sid>` in its history? Links a live session id to
/// its managed notes.md when active-sessions.json has no entry — a resumed archived/closed
/// session is de-registered but still records every session in its lineage as a
/// `session=<id>` history line. (Session ids are full UUIDs, so a substring match can't
/// collide with a different id.)
fn notes_records_session(content: &str, sid: &str) -> bool {
    !sid.is_empty() && content.contains(&format!("session={sid}"))
}

/// Does this notes.md's history record a live session id that is registered to NO
/// workspace? Such an orphan (an archived/closed session resumed directly) is relinked
/// into Running by `recover_unregistered` through this same `session=<id>` line, so
/// `scan_historical` must drop the workspace to avoid double-listing it.
///
/// A live id that IS registered is deliberately not an orphan. One registered to THIS
/// path is already handled by the `active_notes` gate; one registered ELSEWHERE is
/// another session merely CREDITED in this history (e.g. a "work done from the X
/// session | session=<id>" handoff line). Counting that as ownership made the workspace
/// vanish from every bucket at once — excluded from stale/closed/archived here, and
/// absent from Running because the live pidfile resolves to the other notes.md.
fn records_orphan_live_session(
    content: &str,
    running_ids: &HashSet<String>,
    active: &Value,
) -> bool {
    running_ids.iter().any(|sid| {
        let registered =
            active.get(sid).and_then(|m| m.get("notes_path")).and_then(Value::as_str);
        registered.is_none() && notes_records_session(content, sid)
    })
}

/// A real Claude session id (UUID-ish: hex + hyphens, ≥32 chars). Filters out
/// `/start-session` placeholders like `to fill (open the parallel session, …)`.
fn is_resumable_sid(s: &str) -> bool {
    s.len() >= 32 && s.contains('-') && s.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

/// When a notes.md carries no real frontmatter session_id (a stub/placeholder), find the
/// most-recently-active session id registered to it in `active` (the parsed
/// active-sessions.json — the caller loads it ONCE per scan, not once per notes.md)
/// whose transcript still exists — so the dashboard can offer Resume, not only Restart.
fn latest_resumable_sid(notes_path: &str, active: &Value) -> Option<String> {
    let mut best: Option<(String, SystemTime)> = None;
    for (sid, e) in active.as_object()? {
        if e.get("notes_path").and_then(Value::as_str) != Some(notes_path) || !is_resumable_sid(sid) {
            continue;
        }
        let tr = read_transcript(sid);
        if !tr.found {
            continue;
        }
        let mt = tr.mtime.unwrap_or(std::time::UNIX_EPOCH);
        if best.as_ref().is_none_or(|(_, bm)| mt > *bm) {
            best = Some((sid.clone(), mt));
        }
    }
    best.map(|(sid, _)| sid)
}

/// For live session ids with no active-sessions.json entry, find the managed notes.md
/// whose history records each id and recover its category / ticket / root / notesPath.
/// Scans the category dirs ONCE; the caller only invokes it when `want` is non-empty.
/// An unmanaged id (in no notes.md) is simply absent from the result → stays "OTHER".
fn recover_unregistered(cfg: &Value, want: &HashSet<String>) -> HashMap<String, Value> {
    let mut found: HashMap<String, Value> = HashMap::new();
    if want.is_empty() {
        return found;
    }
    let scan_dirs = cfg.get("scanDirs").and_then(Value::as_array).cloned().unwrap_or_default();
    for sd in &scan_dirs {
        let Some(base) = sd.get("base").and_then(Value::as_str) else { continue };
        let category = sd.get("category").and_then(Value::as_str).unwrap_or("");
        let root = sd.get("root").cloned().unwrap_or(Value::Null);
        let Ok(entries) = fs::read_dir(base) else { continue };
        for entry in entries.flatten() {
            if found.len() == want.len() {
                return found; // every wanted id recovered — stop early
            }
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let notes = dir.join("notes.md");
            let Ok(content) = fs::read_to_string(&notes) else { continue };
            let hits: Vec<String> = want
                .iter()
                .filter(|s| !found.contains_key(*s) && notes_records_session(&content, s))
                .cloned()
                .collect();
            if hits.is_empty() {
                continue;
            }
            let fm = parse_frontmatter(&content);
            let meta = json!({
                "category": category,
                "ticket": fv(&fm, "ticket"),
                "name": fv(&fm, "name"),
                "notesPath": notes.to_string_lossy().into_owned(),
                "root": root.clone(),
            });
            for sid in hits {
                found.insert(sid, meta.clone());
            }
        }
    }
    found
}

/// Parse the leading `---\n…\n---` YAML-ish frontmatter into key→value pairs
/// (stripping surrounding quotes; empty values are dropped = treated as absent).
fn parse_frontmatter(content: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(stripped) = content.strip_prefix("---\n") {
        if let Some(end) = stripped.find("\n---") {
            for line in stripped[..end].lines() {
                if let Some(idx) = line.find(':') {
                    let key = line[..idx].trim();
                    let val = line[idx + 1..]
                        .trim()
                        .trim_matches(|c| c == '"' || c == '\'' || c == '\\')
                        .trim();
                    if !key.is_empty() && !val.is_empty() {
                        out.insert(key.to_string(), val.to_string());
                    }
                }
            }
        }
    }
    out
}

/// Days since the Unix epoch for a proleptic-Gregorian Y/M/D (Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Parse a leading `YYYY-MM-DD` into days-since-epoch.
fn date_to_days(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    Some(days_from_civil(y, m, d))
}

/// True when the transcript was modified MORE THAN A DAY after the session's last
/// `/close-session` — i.e. the session was reopened (resumed) and worked on without a
/// fresh `/close-session`.
///
/// `close_date` is a LOCAL calendar day (`/close-session` stamps `date +%Y-%m-%d`), but
/// `tr.mtime` is a UTC instant. Bucketing the UTC mtime into a UTC day and comparing it
/// to a local day can be off by one at the day boundary: in a negative-UTC-offset zone
/// (the Americas), an evening close writes today's local date while the UTC mtime has
/// already rolled to tomorrow — so a plain `mtime_day > close_day` fired the instant the
/// session was closed and flipped it Closed→Stale. The max civil-offset skew is <24h, so
/// requiring a *strictly-more-than-one-day* gap (`+ 1`) absorbs it in every timezone. The
/// cost is that a genuine same-/next-day reopen isn't flagged stale until the following
/// day — an acceptable, self-healing lag versus a wrong flip right after closing.
fn reopened_after_close(tr: &Transcript, close_date: &str) -> bool {
    let close_days = match date_to_days(close_date) {
        Some(d) => d,
        None => return false,
    };
    let mtime_days = match tr.mtime.and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok()) {
        Some(d) => (d.as_secs() / 86400) as i64,
        None => return false,
    };
    mtime_days > close_days + 1
}

/// First `YYYY-MM-DD` (optionally ` HH:MM`) found in a line.
fn lead_date(line: &str) -> Option<String> {
    let c: Vec<char> = line.chars().collect();
    let d = |i: usize| c.get(i).is_some_and(|ch| ch.is_ascii_digit());
    for i in 0..c.len() {
        if d(i) && d(i + 1) && d(i + 2) && d(i + 3) && c.get(i + 4) == Some(&'-')
            && d(i + 5) && d(i + 6) && c.get(i + 7) == Some(&'-') && d(i + 8) && d(i + 9)
        {
            if c.get(i + 10) == Some(&' ') && d(i + 11) && d(i + 12)
                && c.get(i + 13) == Some(&':') && d(i + 14) && d(i + 15)
            {
                return Some(c[i..i + 16].iter().collect());
            }
            return Some(c[i..i + 10].iter().collect());
        }
    }
    None
}

/// Work-lifecycle status from the `## Session history` section + the relevant date:
/// - `archived`: an ARCHIVED line.
/// - `closed`: wrapped up via `/close-session` — the LAST entry is a completed line (`/save-session`
///   marks its entries `(in progress)`, `/close-session` does not).
/// - `stale`: open work whose terminal is gone — last entry still `(in progress)`, or
///   the section is empty/absent (never saved/closed). These belong in the Running
///   tab, not Closed.
pub(crate) fn session_history_info(content: &str) -> (String, Option<String>) {
    let history = match extract_section(content, "Session history") {
        Some(h) => h,
        None => return ("stale".into(), None),
    };
    let lines: Vec<&str> = history.lines().filter(|l| l.trim_start().starts_with('-')).collect();
    if lines.is_empty() {
        return ("stale".into(), None);
    }
    // A genuine archive is the pipe-delimited `| ARCHIVED |` token that
    // /archive-session writes — NOT the word "archived" appearing in summary prose
    // (the dashboard's own project notes discuss archiving constantly, which used to
    // false-positive the whole session as Archived).
    if let Some(a) = lines.iter().find(|l| l.split('|').any(|seg| seg.trim() == "ARCHIVED")) {
        return ("archived".into(), lead_date(a));
    }
    // The NEWEST-dated entry decides the state — not the last physical line. A session
    // worked across several days can end up with history lines out of order (a later
    // edit inserting an earlier-dated entry); taking the last physical line then reads
    // a stale older date, which `reopened_after_close` mistakes for a post-close reopen
    // and wrongly flips closed→stale. Ties (same day) → the later physical line.
    let latest = lines[(0..lines.len())
        .max_by_key(|&i| (lead_date(lines[i]).as_deref().and_then(date_to_days), i))
        .unwrap()]; // lines is non-empty (checked above)
    if is_wrapped_up(latest) {
        ("closed".into(), lead_date(latest))
    } else {
        ("stale".into(), lead_date(latest))
    }
}

/// Extract the summary segment (last `|`-delimited field) from a Session-history line.
/// Used to populate lastSummary in historical session cards.
/// Returns None if the line has no `|` delimiter (or fewer than 3 fields).
fn extract_history_summary(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('-') {
        return None;
    }
    let content = trimmed.trim_start_matches('-').trim();
    let segments: Vec<&str> = content.split('|').collect();
    // Expect at least 3 segments: date | field2 | summary.
    if segments.len() >= 3 {
        let summary = segments[segments.len() - 1].trim();
        if !summary.is_empty() {
            return Some(summary.to_string());
        }
    }
    None
}

/// The summary segment of the NEWEST-dated `## Session history` line (the same line
/// `session_history_info` picks for the state). `None` when no history line carries a
/// summary yet — callers then show NO summary at all (never raw transcript output). This
/// is what a session's card/detail shows as its one-line "what was done", written by
/// `/save-session` (in-progress) and `/close-session`.
fn last_history_summary(content: &str) -> Option<String> {
    let hist = extract_section(content, "Session history")?;
    let lines: Vec<&str> = hist.lines().filter(|l| l.trim_start().starts_with('-')).collect();
    if lines.is_empty() {
        return None;
    }
    let latest = lines[(0..lines.len())
        .max_by_key(|&i| (lead_date(lines[i]).as_deref().and_then(date_to_days), i))
        .unwrap()];
    extract_history_summary(latest)
}

/// Extract the last text block from an assistant message, cleaning markdown and filtering noise.
/// Strips headers (`#`), code fences (```), collapses whitespace, and skips blocks < ~15 chars.
/// Used for live activity display on running sessions.
fn extract_last_activity_block(blocks: &[&str]) -> Option<String> {
    for block in blocks.iter().rev() {
        let cleaned = clean_markdown_block(block);
        if cleaned.len() >= 15 {
            return Some(cleaned);
        }
    }
    None
}

/// Clean markdown from a text block: strip headers (`#...`), code fences, collapse whitespace.
fn clean_markdown_block(text: &str) -> String {
    let mut result = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        // Skip header lines and code fences
        if trimmed.starts_with('#') || trimmed.starts_with("```") {
            continue;
        }
        if !trimmed.is_empty() {
            if !result.is_empty() {
                result.push(' ');
            }
            result.push_str(trimmed);
        }
    }
    // Collapse multiple spaces into one
    result.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Does a `## Session history` line mark a wrap-up (`/close-session`)?
///
/// `/close-session` stamps a summary entry tagged `… | session=<id> | …` with NO in-progress
/// marker. `/save-session` writes the same shape but flagged `(in progress)` (still open), and
/// `/start-session` writes a bootstrap line without `session=` — both stay `stale`. Older
/// `/close-session` output used a `HH:MM → HH:MM` (or `?? → HH:MM`) time range instead of the
/// `session=` tag; still honoured for back-compat. (A `→` buried in a free-text summary
/// like "ADR 0028→0026" isn't preceded by HH:MM, so it doesn't false-positive.)
fn is_wrapped_up(line: &str) -> bool {
    // `/save-session` checkpoints are explicitly mid-session — never a close.
    if line.contains("(in progress)") {
        return false;
    }
    // Current `/close-session` format: a summary entry carrying `session=<id>`.
    if line.contains("session=") {
        return true;
    }
    // Legacy `/close-session` format: a "HH:MM → HH:MM" (or "?? → HH:MM") time range.
    // Require the arrow to sit BETWEEN two clock tokens — left ends with HH:MM (or the
    // `??` placeholder), AND right STARTS with HH:MM. Checking only the left side let a
    // free-text line like "… 14:30 → discuss next steps" false-positive as a close.
    let Some(pos) = line.find('→') else {
        return false;
    };
    let left = line[..pos].trim_end();
    let right = line[pos + '→'.len_utf8()..].trim_start();
    (left.ends_with("??") || ends_with_hhmm(left)) && starts_with_hhmm(right)
}

/// The first 5 bytes read as `HH:MM` (two digits, colon, two digits).
fn starts_with_hhmm(s: &str) -> bool {
    is_hhmm(s.as_bytes())
}

/// The last 5 bytes read as `HH:MM`.
fn ends_with_hhmm(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 5 && is_hhmm(&b[b.len() - 5..])
}

fn is_hhmm(b: &[u8]) -> bool {
    b.len() >= 5
        && b[0].is_ascii_digit()
        && b[1].is_ascii_digit()
        && b[2] == b':'
        && b[3].is_ascii_digit()
        && b[4].is_ascii_digit()
}

fn fv(fm: &HashMap<String, String>, key: &str) -> Value {
    fm.get(key).map(|s| Value::String(s.clone())).unwrap_or(Value::Null)
}

/// One pass over every category dir → all historical (non-running) sessions, each
/// tagged with its `historyStatus` bucket. Callers filter (one status) or partition
/// (all three) — doing the scan ONCE is the win: boot's badge-seed and every board
/// poll need all three buckets at once (previously 3 separate full scans each time).
fn scan_historical() -> Vec<Value> {
    let cfg = crate::config::load();
    let scan_dirs = cfg.get("scanDirs").and_then(Value::as_array).cloned().unwrap_or_default();

    // Exclude sessions that are currently live (running tab owns them). Cheap scan —
    // no transcript/git work (was a full get_sessions() that duplicated the running poll).
    let (running_ids, active_notes) = running_session_ids();
    // Parsed once for the whole scan; latest_resumable_sid needs it per stub notes.md.
    let active_registry = load_active_sessions();

    let mut out = Vec::new();
    for sd in &scan_dirs {
        let base = match sd.get("base").and_then(Value::as_str) {
            Some(b) => b,
            None => continue,
        };
        let category = sd.get("category").and_then(Value::as_str).unwrap_or("");
        let root = sd.get("root").cloned().unwrap_or(Value::Null);
        let entries = match fs::read_dir(base) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let notes = dir.join("notes.md");
            let content = match fs::read_to_string(&notes) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let (mut hist_status, hist_date) = session_history_info(&content);
            let fm = parse_frontmatter(&content);
            let notes_path = notes.to_string_lossy().into_owned();
            // Effective resumable id: the frontmatter session_id if it's a real UUID, else
            // the latest id registered to this notes.md in active-sessions.json. A
            // /start-session stub leaves session_id as a "to fill (…)" placeholder, so
            // without this Resume is never offered (only Restart) even when a live
            // transcript exists.
            let eff_sid = fm
                .get("session_id")
                .filter(|s| is_resumable_sid(s))
                .cloned()
                .or_else(|| latest_resumable_sid(&notes_path, &active_registry));
            let tr = eff_sid.as_ref().map(|sid| read_transcript(sid));
            // A "closed" session whose transcript was touched on a LATER day than its
            // last /close-session was reopened (resumed) + worked on without re-closing →
            // surface it as stale (open work) rather than closed. (Resume/restart-session don't
            // write the notes, so this transcript-mtime check is the only reliable
            // signal; genuinely-closed sessions, untouched since, stay closed.)
            if hist_status == "closed" {
                if let (Some(t), Some(date)) = (tr.as_ref(), hist_date.as_deref()) {
                    if reopened_after_close(t, date) {
                        hist_status = "stale".to_string();
                    }
                }
            }
            // Lifecycle bucket (closed | stale | archived) is carried on each session
            // as `historyStatus`; the caller filters/partitions. Exclude live sessions
            // (the Running tab owns them) regardless of bucket.
            if let Some(sid) = eff_sid.as_ref() {
                if running_ids.contains(sid) {
                    continue;
                }
            }
            if active_notes.contains(&notes_path) {
                continue;
            }
            // A managed session that's currently LIVE belongs to the Running tab — even
            // when it's de-registered from active-sessions.json (e.g. an archived/closed
            // session resumed directly). get_sessions recovers it into Running via the
            // same `session=<id>` history link, so exclude it here to avoid double-listing.
            // Only an UNREGISTERED live id counts as owning this workspace — a live id
            // registered elsewhere is another session merely credited in this history.
            if records_orphan_live_session(&content, &running_ids, &active_registry) {
                continue;
            }

            let updated_at = fs::metadata(&notes)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| Value::from(d.as_millis() as f64))
                .unwrap_or(Value::Null);
            let name = fm.get("name").cloned().unwrap_or_else(|| {
                dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
            });
            let cat = fm.get("category").cloned().unwrap_or_else(|| category.to_string());

            // Resume is keyed by the dir `claude` was LAUNCHED from (not where it
            // later cd'd to) — use the transcript's first cwd. Fall back to the
            // category's root (the parent of <root>/<CAT>) so a session resumes
            // from the configured root, not the home directory.
            let root_dir = std::path::Path::new(base)
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Resumable only if the transcript still exists (else --resume can't
            // find the conversation — the UI should offer Restart instead).
            let resumable = tr.as_ref().map(|t| t.found).unwrap_or(false);
            // PR link: explicit frontmatter wins; else (REVIEW only) the PR URL pasted
            // into the transcript, disambiguated by the number in the session name.
            let pr_urls = tr.as_ref().map(|t| t.pr_urls.as_slice()).unwrap_or(&[]);
            let pr_link = resolve_pr_link(fv(&fm, "pr_link"), &cat, pr_urls, name.as_str());
            // Last real activity from the transcript (e.g. Pause kills the pty without
            // touching notes.md, so its mtime can be a stale prior save/close — the
            // renderer takes the MORE RECENT of updatedAt vs lastActivityAt for the age
            // pill, so a same-day Pause doesn't display a days-old "last activity").
            let last_activity_at = tr.as_ref().and_then(|t| t.last_activity_at.clone());
            let cwd = tr.and_then(|t| t.launch_cwd).unwrap_or(root_dir);

            let last_summary = last_history_summary(&content);

            out.push(json!({
                "notesPath": notes_path,
                "sessionId": eff_sid.clone().map(Value::String).unwrap_or(Value::Null),
                "cwd": cwd,
                "resumable": resumable,
                "category": cat,
                "root": root.clone(),
                "ticket": fv(&fm, "ticket"),
                "name": name,
                "branch": fv(&fm, "branch"),
                "prLink": pr_link,
                "startedAt": fv(&fm, "started_at"),
                "updatedAt": updated_at,
                "lastActivityAt": last_activity_at,
                "state": hist_status.clone(),   // stale | closed | archived
                "historyStatus": hist_status,
                "historyDate": hist_date,
                "goal": extract_section(&content, "Goal").map(Value::String).unwrap_or(Value::Null),
                "nextSteps": extract_section(&content, "Next steps").map(Value::String).unwrap_or(Value::Null),
                "lastSummary": last_summary.map(Value::String).unwrap_or(Value::Null),
            }));
        }
    }
    out
}

/// Sessions in a single lifecycle bucket (stale | closed | archived). One scan,
/// filtered — used when a single tab is visited.
#[tauri::command(async)]
pub fn get_historical_sessions(status: String) -> Vec<Value> {
    scan_historical()
        .into_iter()
        .filter(|s| s.get("historyStatus").and_then(Value::as_str) == Some(status.as_str()))
        .collect()
}

/// All three buckets from ONE scan: `{ stale, closed, archived }`. Used by the boot
/// badge-seed and the board index, which both need every bucket at once — replaces
/// three separate full directory scans with one.
#[tauri::command(async)]
pub fn get_historical_sessions_all() -> Value {
    bucket_by_status(scan_historical())
}

/// Partition tagged historical sessions into `{ stale, closed, archived }`. Pure (no
/// I/O) → unit-tested. `stale` is the default bucket (open work, terminal gone).
fn bucket_by_status(all: Vec<Value>) -> Value {
    let (mut stale, mut closed, mut archived) = (Vec::new(), Vec::new(), Vec::new());
    for s in all {
        match s.get("historyStatus").and_then(Value::as_str) {
            Some("closed") => closed.push(s),
            Some("archived") => archived.push(s),
            _ => stale.push(s),
        }
    }
    json!({ "stale": stale, "closed": closed, "archived": archived })
}

#[cfg(test)]
mod tests {
    use super::{
        bucket_by_status, date_to_days, discover_meta_lines, extract_pr_urls, lead_date,
        is_resumable_sid, notes_records_session, parse_frontmatter, pick_pr_url,
        reopened_after_close, root_for_notes_path, session_history_info, Transcript,
    };
    use crate::is_valid_session_id;
    use serde_json::json;

    #[test]
    fn select_unmanaged_excludes_managed_skips_and_caps_at_30() {
        use std::collections::HashSet;
        let mut managed = HashSet::new();
        managed.insert("managed-1".to_string());

        // 32 candidate rows with ascending mtime; two are special-cased.
        let mut rows: Vec<(u64, String, Option<String>, Option<String>, bool)> = Vec::new();
        for i in 0..32u64 {
            rows.push((i, format!("sid-{i}"), Some(format!("title {i}")), Some("/tmp/x".into()), false));
        }
        rows.push((999, "managed-1".to_string(), Some("m".into()), Some("/tmp".into()), false)); // managed → dropped
        rows.push((998, "skipme".to_string(), Some("s".into()), Some("/tmp".into()), true));      // skip=true → dropped

        let out = super::select_unmanaged(rows, &managed);

        // Managed + skipped are gone; result capped to 30.
        assert_eq!(out.len(), 30);
        let ids: Vec<&str> = out.iter().map(|v| v["sessionId"].as_str().unwrap()).collect();
        assert!(!ids.contains(&"managed-1"));
        assert!(!ids.contains(&"skipme"));
        // Newest first: the highest surviving mtime (sid-31) leads.
        assert_eq!(out[0]["sessionId"], "sid-31");
        assert_eq!(out[0]["title"], "title 31");
        assert_eq!(out[0]["mtime"], 31);
        // Cap drops the 2 oldest survivors (sid-0, sid-1).
        assert!(!ids.contains(&"sid-0"));
        assert!(!ids.contains(&"sid-1"));
    }

    #[test]
    fn sid_validator_blocks_path_traversal() {
        // The shared validator also guards the `{sid}.jsonl` path built here — the
        // path-shaped rejections are THIS module's contract, so they're locked here.
        assert!(is_valid_session_id("b59fd8e8-fe1e-4ac5-bf6d-9a242a7f900f"));
        assert!(is_valid_session_id("abc_123-XYZ"));
        assert!(!is_valid_session_id("../../.ssh/id_rsa")); // slashes + dots → traversal
        assert!(!is_valid_session_id("a.b")); // a dot would let `{sid}.jsonl` climb dirs
        assert!(!is_valid_session_id("a/b")); // path separator
    }

    #[test]
    fn is_resumable_sid_accepts_uuid_rejects_placeholder() {
        assert!(is_resumable_sid("b59fd8e8-fe1e-4ac5-bf6d-9a242a7f900f"));
        // /start-session "to fill (…)" stub is not a resumable id → UI offers Restart only.
        assert!(!is_resumable_sid("to fill (open the parallel session, then /restart-session X)"));
        assert!(!is_resumable_sid(""));
        assert!(!is_resumable_sid("short"));
    }

    #[test]
    fn notes_records_session_links_live_id_via_history_line() {
        let content = "## Session history\n- 2026-06-04 | ARCHIVED | archived via /archive\n\
            - 2026-06-08 | session=b96f3fd7-2b41-4ba9-b584-fad5dcb850f8 | handoff written\n";
        // The exact live id recorded in a `session=` line is found…
        assert!(notes_records_session(content, "b96f3fd7-2b41-4ba9-b584-fad5dcb850f8"));
        // …an unrelated id is not, and an empty id never matches.
        assert!(!notes_records_session(content, "deadbeef-0000-0000-0000-000000000000"));
        assert!(!notes_records_session(content, ""));
    }

    #[test]
    fn records_orphan_live_session_ignores_a_live_id_owned_by_another_workspace() {
        use std::collections::HashSet;
        // Regression: a history line can CREDIT work done from a different session. That
        // id is live and registered to its OWN workspace, so it must not mark this one as
        // live — doing so hid the workspace from stale/closed/archived while Running
        // showed it under the other notes.md, i.e. it vanished from every tab.
        let content = "## Session history\n\
            - 2026-06-12 (work done from the GOSDK-214656 session) | \
            session=04b11297-447a-49db-8c68-535cd35f7acf | committed the batch\n\
            - 2026-06-26 | session=034a5675-0a10-40d1-804b-7b8df061ea09 | reviewed 2 PRs\n";
        let mut running = HashSet::new();
        running.insert("04b11297-447a-49db-8c68-535cd35f7acf".to_string());

        let credited_elsewhere = json!({
            "04b11297-447a-49db-8c68-535cd35f7acf": { "notes_path": "/w/BUG/GOSDK-214656/notes.md" }
        });
        assert!(!super::records_orphan_live_session(content, &running, &credited_elsewhere));

        // A live id registered to NO workspace is the genuine orphan this gate exists for
        // (an archived/closed session resumed directly) — recover_unregistered relinks it
        // into Running via this same line, so the workspace must still be excluded here.
        let unregistered = json!({});
        assert!(super::records_orphan_live_session(content, &running, &unregistered));

        // An entry without a notes_path is not a claim of ownership either → still orphan.
        let entry_without_path = json!({ "04b11297-447a-49db-8c68-535cd35f7acf": { "category": "BUG" } });
        assert!(super::records_orphan_live_session(content, &running, &entry_without_path));

        // No live ids at all → nothing to exclude.
        assert!(!super::records_orphan_live_session(content, &HashSet::new(), &unregistered));

        // A live id this notes.md never records → not its owner.
        let mut other = HashSet::new();
        other.insert("deadbeef-0000-0000-0000-000000000000".to_string());
        assert!(!super::records_orphan_live_session(content, &other, &unregistered));
    }

    #[test]
    fn root_for_notes_path_matches_longest_base_and_handles_unknown() {
        let cfg = json!({
            "scanDirs": [
                { "category": "FEAT", "base": "/w/FEAT", "root": "Work" },
                { "category": "PERSO", "base": "/p/PERSO", "root": "Perso" },
                // Same category name under a second root — the longer base must win.
                { "category": "AI-SYSTEM", "base": "/w/AI-SYSTEM", "root": "Work" },
                { "category": "AI-SYSTEM", "base": "/p/AI-SYSTEM", "root": "Perso" },
            ]
        });
        let root = |p: &str| root_for_notes_path(&cfg, p);
        assert_eq!(root("/w/FEAT/my-slug/notes.md"), json!("Work"));
        assert_eq!(root("/p/PERSO/x/notes.md"), json!("Perso"));
        assert_eq!(root("/p/AI-SYSTEM/x/notes.md"), json!("Perso"));
        assert_eq!(root("/w/AI-SYSTEM/x/notes.md"), json!("Work"));
        // Component-aware: a sibling that merely shares a string prefix with a base
        // (FEAT vs FEAT-bug) must NOT be tagged — only a real path-component match counts.
        assert_eq!(root("/w/FEAT-bug/x/notes.md"), json!(null));
        // Outside every configured root → Null (renderer shows it under all roots).
        assert_eq!(root("/tmp/elsewhere/notes.md"), json!(null));
    }

    #[test]
    fn parse_frontmatter_strips_quotes_drops_empty_requires_closing() {
        let fm = "---\nname: \"My Session\"\ncategory: FEAT\nempty: \nticket: 'ABC-1'\n---\nbody";
        let m = parse_frontmatter(fm);
        assert_eq!(m.get("name").map(String::as_str), Some("My Session"));
        assert_eq!(m.get("category").map(String::as_str), Some("FEAT"));
        assert_eq!(m.get("ticket").map(String::as_str), Some("ABC-1"));
        assert!(!m.contains_key("empty")); // empty value → dropped (treated as absent)
        assert!(parse_frontmatter("---\nname: x\nno closing marker").is_empty()); // no closing ---
        assert!(parse_frontmatter("# just a heading\n").is_empty()); // no frontmatter
    }

    #[test]
    fn lead_date_finds_first_date_with_optional_time() {
        assert_eq!(lead_date("- 2026-06-10 14:43 | x").as_deref(), Some("2026-06-10 14:43"));
        assert_eq!(lead_date("- 2026-06-10 | x").as_deref(), Some("2026-06-10"));
        assert_eq!(lead_date("no date here"), None);
    }

    #[test]
    fn session_history_info_recognises_close_save_start_archive() {
        let status = |hist: &str| {
            let content = format!("## Goal\nx\n\n## Session history\n{hist}\n");
            session_history_info(&content).0
        };
        // /close-session — current format: `… | session=<id> | summary`, no (in progress)
        assert_eq!(
            status("- 2026-06-19 21:11 | session=abc | transcript=/p.jsonl | Merged the fix"),
            "closed"
        );
        // /save-session checkpoint — same shape but explicitly mid-session
        assert_eq!(
            status("- 2026-06-19 19:22 (in progress) | session=abc | transcript=/p.jsonl | Triaged"),
            "stale"
        );
        // /start-session bootstrap — no session= marker
        assert_eq!(status("- 2026-06-18 16:53 — session started (BUG | slug | TICKET)."), "stale");
        // legacy /close-session — leading "HH:MM → HH:MM" time range
        assert_eq!(status("- 2026-06-10 | 09:00 → 11:30 | wrapped up"), "closed");
        // a /save-session AFTER a close (reopened, last line in progress) → stale
        assert_eq!(
            status("- 2026-06-18 | session=abc | closed it\n- 2026-06-19 (in progress) | session=abc | back at it"),
            "stale"
        );
        // the genuine "| ARCHIVED |" marker wins regardless of position
        assert_eq!(
            status("- 2026-06-19 | session=abc | done\n- 2026-06-20 | ARCHIVED | archived via /archive-session"),
            "archived"
        );
        // the WORD "archived" in summary prose must NOT classify the session as archived
        assert_eq!(
            status("- 2026-06-19 | session=abc | archived the old branch and shipped the fix"),
            "closed"
        );
        // no history section → stale
        assert_eq!(session_history_info("## Goal\nx\n").0, "stale");
    }

    #[test]
    fn legacy_arrow_close_needs_a_clock_on_both_sides() {
        let status = |hist: &str| {
            let content = format!("## Session history\n{hist}\n");
            session_history_info(&content).0
        };
        // genuine legacy close range → closed
        assert_eq!(status("- 2026-06-10 | 09:00 → 11:30 | wrapped up"), "closed");
        // dashboard close_session fallback shape "?? → HH:MM" → closed
        assert_eq!(status("- 2026-06-10 ?? → 14:30 | closed from the dashboard"), "closed");
        // free-text with a clock time BEFORE an arrow → NOT a close (was the false positive)
        assert_eq!(status("- 2026-06-11 | synced at 14:30 → follow up tomorrow"), "stale");
        // clock on the left but prose on the right → NOT a close
        assert_eq!(status("- 2026-06-11 10:45 → ship it"), "stale");
        // `??` on the left but no clock on the right → NOT a close
        assert_eq!(status("- 2026-06-11 ?? → ship it"), "stale");
    }

    #[test]
    fn session_history_info_uses_newest_dated_entry_not_last_physical_line() {
        // Out-of-order history: the close (06-20) sits ABOVE an older entry (06-18).
        // The state + date must come from the newest-dated line, else the stale 06-18
        // date trips reopened_after_close and the session wrongly reads as stale.
        let content = "## Session history\n\
            - 2026-06-20 00:03 | session=abc | Closed for the weekend\n\
            - 2026-06-18 16:01 | session=abc | earlier CI rerun note\n";
        let (status, date) = session_history_info(content);
        assert_eq!(status, "closed");
        assert_eq!(date.as_deref(), Some("2026-06-20 00:03"));
    }

    #[test]
    fn discover_meta_lines_takes_first_real_user_msg_and_first_cwd() {
        let lines = vec![
            r#"{"type":"user","cwd":"/Users/dev/proj","message":{"content":"<system-reminder>ctx</system-reminder>"}}"#.to_string(),
            r#"{"type":"assistant","cwd":"/Users/dev/proj","message":{"content":[{"type":"text","text":"working"}]}}"#.to_string(),
            r#"{"type":"user","cwd":"/Users/dev/elsewhere","message":{"content":"Fix the checkout bug"}}"#.to_string(),
        ];
        let (title, cwd, skip) = discover_meta_lines(lines.into_iter());
        assert_eq!(title.as_deref(), Some("Fix the checkout bug")); // injected noise skipped
        assert_eq!(cwd.as_deref(), Some("/Users/dev/proj")); // FIRST cwd (launch dir)
        assert!(!skip); // a plain session (no command markup) is kept
        // slash-command run (first user turn carries <command-name>) → skipped
        let cmd = vec![r#"{"type":"user","message":{"content":"<command-name>/release-notes</command-name>\n<command-args></command-args>"}}"#.to_string(),
            r#"{"type":"user","message":{"content":"Generate the release notes for the current PR"}}"#.to_string()];
        assert!(discover_meta_lines(cmd.into_iter()).2);
        // sub-agent sidechain → skipped
        let side = vec![r#"{"type":"user","isSidechain":true,"message":{"content":"do a thing"}}"#.to_string()];
        assert!(discover_meta_lines(side.into_iter()).2);
        // injected noise (skill body, system-reminder) is skipped; real prompt wins
        let noisy = vec![
            r#"{"type":"user","message":{"content":"Base directory for this skill is /x"}}"#.to_string(),
            r#"{"type":"user","message":{"content":"Generate the release notes"}}"#.to_string(),
        ];
        assert_eq!(discover_meta_lines(noisy.into_iter()).0.as_deref(), Some("Generate the release notes"));
        // array with an injected block THEN the real prompt → picks the real one
        let arr = vec![r#"{"type":"user","message":{"content":[{"type":"text","text":"<system-reminder>x</system-reminder>"},{"type":"text","text":"hello there"}]}}"#.to_string()];
        assert_eq!(discover_meta_lines(arr.into_iter()).0.as_deref(), Some("hello there"));
        // no real user message → no title
        let none = vec![r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x"}]}}"#.to_string()];
        assert_eq!(discover_meta_lines(none.into_iter()).0, None);
    }

    #[test]
    fn reopened_after_close_needs_more_than_a_days_gap() {
        use std::time::{Duration, UNIX_EPOCH};
        let close = "2026-06-10";
        let day = date_to_days(close).unwrap() as u64;
        let with_mtime = |secs: u64| Transcript {
            mtime: Some(UNIX_EPOCH + Duration::from_secs(secs)),
            ..Default::default()
        };
        // same calendar day (a few hours later) → NOT reopened
        assert!(!reopened_after_close(&with_mtime(day * 86400 + 5 * 3600), close));
        // next UTC day → NOT reopened: this is exactly the local-vs-UTC-day skew a
        // negative-offset (Americas) evening close produces, and must not flip Closed→Stale.
        assert!(!reopened_after_close(&with_mtime((day + 1) * 86400 + 2 * 3600), close));
        // two days later → genuinely reopened
        assert!(reopened_after_close(&with_mtime((day + 2) * 86400), close));
        // no transcript mtime → false
        assert!(!reopened_after_close(&Transcript::default(), close));
    }

    #[test]
    fn bucket_by_status_partitions_and_defaults_unknown_to_stale() {
        let all = vec![
            json!({ "name": "a", "historyStatus": "closed" }),
            json!({ "name": "b", "historyStatus": "archived" }),
            json!({ "name": "c", "historyStatus": "stale" }),
            json!({ "name": "d", "historyStatus": "closed" }),
            json!({ "name": "e" }), // no status → defaults to stale
        ];
        let out = bucket_by_status(all);
        assert_eq!(out["closed"].as_array().unwrap().len(), 2);
        assert_eq!(out["archived"].as_array().unwrap().len(), 1);
        assert_eq!(out["stale"].as_array().unwrap().len(), 2); // c + the untagged e
        // every input lands in exactly one bucket (no loss, no dupes)
        let total = ["stale", "closed", "archived"]
            .iter()
            .map(|k| out[*k].as_array().unwrap().len())
            .sum::<usize>();
        assert_eq!(total, 5);
    }

    #[test]
    fn date_to_days_is_monotonic_and_parses() {
        let d10 = date_to_days("2026-06-10 14:43").unwrap();
        let d18 = date_to_days("2026-06-18").unwrap();
        assert!(d18 > d10, "later date → more days");
        assert_eq!(date_to_days("2026-06-10"), date_to_days("2026-06-10 09:00"));
        assert!(date_to_days("nope").is_none());
        // 8 days apart
        assert_eq!(d18 - d10, 8);
    }

    fn state_of(notes: &str) -> String {
        session_history_info(notes).0
    }

    #[test]
    fn history_closed_when_last_entry_is_a_completed_line() {
        let n = "## Session history\n- 2026-06-10 09:00 → 09:40 | session=x | wrapped up\n";
        assert_eq!(state_of(n), "closed");
    }

    #[test]
    fn history_stale_when_last_entry_is_in_progress() {
        // /save-session leaves an "(in progress)" line; killing the terminal never closes it.
        let n = "## Session history\n- 2026-06-10 09:00 (in progress) | session=x | saved\n";
        assert_eq!(state_of(n), "stale");
    }

    #[test]
    fn history_stale_when_never_saved() {
        assert_eq!(state_of("## Session history\n"), "stale");
        assert_eq!(state_of("# Title\nno history section"), "stale");
    }

    #[test]
    fn history_archived_takes_precedence() {
        let n = "## Session history\n- 2026-06-10 09:00 → 09:40 | did stuff\n- 2026-06-11 | ARCHIVED | from dashboard\n";
        assert_eq!(state_of(n), "archived");
    }

    #[test]
    fn history_stale_when_last_entry_is_a_start_bootstrap_line() {
        // A /start-session bootstrap line is NOT a wrap-up (no HH:MM → time range).
        let n = "## Session history\n- 2026-06-11: /start-session — workspace bootstrapped, context imported.\n";
        assert_eq!(state_of(n), "stale");
    }

    #[test]
    fn history_stale_when_arrow_is_free_text_not_a_time_range() {
        // A "→" inside the summary must not be read as the /close-session time-range arrow.
        let n = "## Session history\n- 2026-06-11: note about ADR 0028→0026 migration\n";
        assert_eq!(state_of(n), "stale");
    }

    #[test]
    fn history_closed_with_unknown_start_time() {
        // /close-session fallback "?? → HH:MM" still counts as wrapped up.
        let n = "## Session history\n- 2026-06-11 ?? → 16:30 | session=x | wrapped up\n";
        assert_eq!(state_of(n), "closed");
    }

    #[test]
    fn history_closed_after_saves_then_close() {
        // Several /save-session (in progress) lines, then a final /close-session completed line → closed.
        let n = "## Session history\n- 2026-06-09 (in progress) | s1\n- 2026-06-10 (in progress) | s2\n- 2026-06-11 10:00 → 10:30 | wrapped up\n";
        assert_eq!(state_of(n), "closed");
    }

    #[test]
    fn extracts_pr_urls_and_ignores_non_pr_github_links() {
        let text = r#"please review https://github.com/o/r/pull/35 and also
            see https://github.com/o/r/issues/9 plus "https://github.com/a/b/pull/4966/files""#;
        let urls = extract_pr_urls(text);
        assert!(urls.contains(&"https://github.com/o/r/pull/35".to_string()));
        assert!(urls.contains(&"https://github.com/a/b/pull/4966/files".to_string()));
        assert!(!urls.iter().any(|u| u.contains("/issues/")));
    }

    #[test]
    fn pick_prefers_url_matching_the_name_number() {
        let urls = vec![
            "https://github.com/o/r/pull/4966".to_string(),
            "https://github.com/o/r/pull/35".to_string(),
            "https://github.com/o/r/pull/4966".to_string(),
        ];
        // Name says PR 35 → that wins even though 4966 is more frequent.
        assert_eq!(
            pick_pr_url(&urls, "review vespa-skill (PR 35)").as_deref(),
            Some("https://github.com/o/r/pull/35")
        );
    }

    #[test]
    fn pick_falls_back_to_most_frequent_without_name_hint() {
        let urls = vec![
            "https://github.com/o/r/pull/10".to_string(),
            "https://github.com/o/r/pull/20".to_string(),
            "https://github.com/o/r/pull/20".to_string(),
        ];
        assert_eq!(pick_pr_url(&urls, "no number here").as_deref(), Some("https://github.com/o/r/pull/20"));
        assert_eq!(pick_pr_url(&[], "x"), None);
    }

    #[test]
    fn name_number_match_is_standalone_not_substring() {
        let urls = vec!["https://github.com/o/r/pull/35".to_string()];
        // "350" must NOT match "35"; with no other candidate, falls back to frequency.
        assert_eq!(
            pick_pr_url(&urls, "ticket 350 something").as_deref(),
            Some("https://github.com/o/r/pull/35") // fallback (only candidate), not a name match
        );
    }

    #[test]
    fn extracts_history_summary_from_pipe_delimited_line() {
        use super::extract_history_summary;
        // Normal close-session format: date | session=id | summary
        assert_eq!(
            extract_history_summary("- 2026-06-10 | session=abc | implemented feature X"),
            Some("implemented feature X".to_string())
        );
        // With leading whitespace
        assert_eq!(
            extract_history_summary("  - 2026-06-10 | session=abc | fixed bug Y"),
            Some("fixed bug Y".to_string())
        );
        // No pipe delimiters → None
        assert_eq!(extract_history_summary("- 2026-06-10 no pipes here"), None);
        // Fewer than 3 segments → None
        assert_eq!(extract_history_summary("- 2026-06-10 | session=abc"), None);
        // Empty summary segment → None
        assert_eq!(extract_history_summary("- 2026-06-10 | session=abc |"), None);
        assert_eq!(extract_history_summary("- 2026-06-10 | session=abc |   "), None);
    }

    #[test]
    fn extracts_last_activity_block_with_markdown_cleanup() {
        use super::extract_last_activity_block;
        // Filters markdown headers and code fences, keeps normal text blocks
        let blocks = vec![
            "# Header line",
            "```rust\ncode block\n```",
            "Real content with multiple words",
        ];
        assert_eq!(
            extract_last_activity_block(&blocks),
            Some("Real content with multiple words".to_string())
        );
        // Collects from last non-trivial block
        let blocks = vec![
            "Setup complete.",
            "Finished the implementation with success",
        ];
        assert_eq!(
            extract_last_activity_block(&blocks),
            Some("Finished the implementation with success".to_string())
        );
        // Skips blocks that are too short (< ~15 chars) after cleanup
        let blocks = vec![
            "Short",
            "Also short",
            "This is a real block with enough content",
        ];
        assert_eq!(
            extract_last_activity_block(&blocks),
            Some("This is a real block with enough content".to_string())
        );
        // All blocks too short → None
        let blocks = vec!["Hi", "OK", "Short"];
        assert_eq!(extract_last_activity_block(&blocks), None);
        // Empty list → None
        assert_eq!(extract_last_activity_block(&[]), None);
    }
}
