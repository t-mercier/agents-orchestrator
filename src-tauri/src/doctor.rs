//! Doctor — find what is genuinely broken in the session store, and repair it on request.
//!
//! Two rules shape this module, and both are about trust rather than capability.
//!
//! **It proposes, it never repairs on its own.** A registry rewrite is as silent and as
//! durable as a clobbered skill, so `scan` is read-only and returns named findings; the
//! user picks, and `repair` applies only what was picked. Doctor has the widest write
//! radius in the app — it does not get to run without a witness.
//!
//! **It only reports what it can prove.** Most of what looks wrong in the store is not:
//! a session id whose transcript Claude Code pruned months ago is normal ageing, and a
//! notes.md registered under six ids is the Resume fallback working as designed
//! (`reader::latest_resumable_sid` scans exactly that multiplicity to find a live id).
//! Counting those as damage would put a four-figure defect count on the first run and
//! cost the tool its credibility. The classifier below deliberately finds few things.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// One thing Doctor observed, and what — if anything — it can do about it.
///
/// `repair` is the fix's human name, or None when the finding is informational: Doctor
/// says what it sees even where the answer is "nothing to do", because an unexplained
/// oddity the user later notices is worse than a line saying it is expected.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Finding {
    /// `<kind>:<target>` — what `repair` is called back with. Stable across scans.
    pub id: String,
    pub kind: String,
    /// `broken` (work is unreachable), `untidy` (residue), `info` (no action).
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub target: String,
    pub repair: Option<String>,
}

/// What Doctor knows about one managed session. Gathered by [`snapshot`], classified by
/// [`findings`] — split so the classifier is a pure function over facts and can be
/// tested against real sessions rather than invented JSON.
#[derive(Clone, Debug, Default)]
pub struct SessionFacts {
    pub notes_path: String,
    pub notes_exists: bool,
    /// The frontmatter `session_id`, when it is a well-formed id (a `/start-session`
    /// placeholder is None — that stub is the collision guard doing its job, not damage).
    pub fm_sid: Option<String>,
    pub fm_sid_has_transcript: bool,
    /// Newest id registered to this notes.md whose conversation is still on disk.
    pub recoverable_sid: Option<String>,
    /// `archived` / `closed` / `stale`, from `reader::session_history_info`.
    pub status: String,
    /// Live pids registered to this notes.md.
    pub live_pids: Vec<i64>,
}

#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub sessions: Vec<SessionFacts>,
    /// `~/.claude/sessions/<pid>.json` files whose process is gone.
    pub stale_pidfiles: Vec<String>,
    /// Skills that differ from their `.ao-base` snapshot — hand-edited since install.
    pub drifted_skills: Vec<String>,
    /// Live session processes the registry has no entry for, as `(pid, cwd)`. Archiving
    /// de-registers a session by design, so a still-running one falls out of every
    /// registry-keyed view — including this scan's own session list.
    pub unregistered_live: Vec<(i64, String)>,
    /// Registered ids whose transcript is gone and that have no live sibling: ordinary
    /// ageing. Counted, never listed — see the module note.
    pub aged_ids: usize,
}

pub const KIND_REGISTRY_ORPHAN: &str = "registry_orphan";
pub const KIND_FRONTMATTER_SID: &str = "frontmatter_sid";
pub const KIND_FINISHED_ALIVE: &str = "finished_alive";
pub const KIND_PIDFILE_STALE: &str = "pidfile_stale";
pub const KIND_SKILL_DRIFT: &str = "skill_drift";
pub const KIND_LIVE_UNREGISTERED: &str = "live_unregistered";
pub const KIND_AGED: &str = "aged_transcripts";

/// Classify a snapshot into findings, most serious first. Pure.
pub fn findings(snap: &Snapshot) -> Vec<Finding> {
    let mut out = Vec::new();

    for s in &snap.sessions {
        // The registry points at a notes.md that is no longer on disk — the session is
        // unreachable and the entry can only mislead the pickers that read it.
        if !s.notes_exists {
            out.push(Finding {
                id: format!("{KIND_REGISTRY_ORPHAN}:{}", s.notes_path),
                kind: KIND_REGISTRY_ORPHAN.into(),
                severity: "broken".into(),
                title: "Registry entry with no notes.md".into(),
                detail: format!("{} is registered but the file is gone.", s.notes_path),
                target: s.notes_path.clone(),
                repair: Some("Drop the entry from active-sessions.json".into()),
            });
            continue; // Every other check needs a file to read.
        }

        // The frontmatter declares an id whose conversation is gone, while another id
        // registered to the same notes.md still has one. Resume already falls back to it
        // at read time; writing it back makes the file agree with what the app does, so
        // any tool reading the frontmatter alone stops pointing at a dead conversation.
        if let (Some(fm), Some(rec)) = (&s.fm_sid, &s.recoverable_sid) {
            if !s.fm_sid_has_transcript && fm != rec {
                out.push(Finding {
                    id: format!("{KIND_FRONTMATTER_SID}:{}", s.notes_path),
                    kind: KIND_FRONTMATTER_SID.into(),
                    severity: "broken".into(),
                    title: "Frontmatter points at a lost conversation".into(),
                    detail: format!(
                        "session_id: {fm} has no transcript; {rec} is registered to the same notes and still has one."
                    ),
                    target: s.notes_path.clone(),
                    repair: Some("Point session_id at the surviving conversation".into()),
                });
            }
        }

        // The notes say the work finished; a registered process says it did not. This is
        // what turns a Resume into "this session is already active" — the list files the
        // session under Closed or Archived while its terminal is still open, so the one
        // action that would reach it is the one the state forbids. Bringing the notes
        // back in line with the running process is the repair; the process is left alone.
        if matches!(s.status.as_str(), "archived" | "closed") && !s.live_pids.is_empty() {
            let pids = s.live_pids.iter().map(i64::to_string).collect::<Vec<_>>().join(", ");
            let archived = s.status == "archived";
            out.push(Finding {
                id: format!("{KIND_FINISHED_ALIVE}:{}", s.notes_path),
                kind: KIND_FINISHED_ALIVE.into(),
                severity: "broken".into(),
                title: if archived { "Archived while still running".into() }
                       else { "Closed while still running".into() },
                detail: format!(
                    "The notes record this session as {}, but pid {pids} is alive. Resume will refuse it as already active until the two agree.",
                    if archived { "archived" } else { "closed" }
                ),
                target: s.notes_path.clone(),
                repair: Some(if archived { "Remove the ARCHIVED marker".into() }
                             else { "Record it as in progress again".into() }),
            });
        }
    }

    // A running session nothing points at. This is what makes Resume answer "already
    // active" for work the list shows as closed: the process is real, but archiving
    // dropped its registry entry, so no view can reach it. Doctor names the pid and
    // stops there — killing someone's running terminal is not a repair, it is a loss.
    for (pid, cwd) in &snap.unregistered_live {
        out.push(Finding {
            id: format!("{KIND_LIVE_UNREGISTERED}:{pid}"),
            kind: KIND_LIVE_UNREGISTERED.into(),
            severity: "broken".into(),
            title: format!("Session running outside the registry (pid {pid})"),
            detail: format!(
                "A live session in {cwd} has no registry entry, so it cannot be reached from the list — and Resume reports it as already active. Reopen it from Running, or quit pid {pid} to release the work."
            ),
            target: pid.to_string(),
            repair: None,
        });
    }

    for p in &snap.stale_pidfiles {
        out.push(Finding {
            id: format!("{KIND_PIDFILE_STALE}:{p}"),
            kind: KIND_PIDFILE_STALE.into(),
            severity: "untidy".into(),
            title: "Pidfile for a process that has exited".into(),
            detail: format!("{p} describes a session whose process is gone."),
            target: p.clone(),
            repair: Some("Delete the pidfile".into()),
        });
    }

    // Reported, never repaired here: overwriting a hand-edit is exactly what the sync
    // path exists to avoid, and it already archives before it writes. Doctor's job is to
    // say the divergence is there.
    for name in &snap.drifted_skills {
        out.push(Finding {
            id: format!("{KIND_SKILL_DRIFT}:{name}"),
            kind: KIND_SKILL_DRIFT.into(),
            severity: "info".into(),
            title: format!("Skill '{name}' was edited by hand"),
            detail: "It differs from the version the app installed. Settings → Skills keeps a copy in .archive before any sync overwrites it.".into(),
            target: name.clone(),
            repair: None,
        });
    }

    if snap.aged_ids > 0 {
        out.push(Finding {
            id: KIND_AGED.into(),
            kind: KIND_AGED.into(),
            severity: "info".into(),
            title: format!("{} session ids have no conversation left", snap.aged_ids),
            detail: "Claude Code prunes old transcripts. Those sessions can still be restarted, only not resumed — nothing to repair.".into(),
            target: String::new(),
            repair: None,
        });
    }

    let rank = |s: &str| match s {
        "broken" => 0,
        "untidy" => 1,
        _ => 2,
    };
    out.sort_by_key(|f| (rank(&f.severity), f.kind.clone(), f.target.clone()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(notes: &str) -> SessionFacts {
        SessionFacts {
            notes_path: notes.into(),
            notes_exists: true,
            status: "stale".into(),
            ..Default::default()
        }
    }

    #[test]
    fn a_healthy_store_yields_nothing() {
        let snap = Snapshot { sessions: vec![session("/n/notes.md")], ..Default::default() };
        assert!(findings(&snap).is_empty());
    }

    /// The case that motivated the module: 14 of her notes files are registered under
    /// several ids, and only the 3 whose frontmatter id is dead are actually broken.
    #[test]
    fn several_ids_on_one_notes_is_not_a_defect() {
        let snap = Snapshot {
            sessions: vec![SessionFacts {
                fm_sid: Some("aaaaaaaa-1111-2222-3333-444444444444".into()),
                fm_sid_has_transcript: true,
                recoverable_sid: Some("bbbbbbbb-1111-2222-3333-444444444444".into()),
                ..session("/n/notes.md")
            }],
            ..Default::default()
        };
        assert!(findings(&snap).is_empty(), "a live frontmatter id needs no repair");
    }

    #[test]
    fn a_dead_frontmatter_id_with_a_survivor_is_repairable() {
        let snap = Snapshot {
            sessions: vec![SessionFacts {
                fm_sid: Some("aaaaaaaa-1111-2222-3333-444444444444".into()),
                fm_sid_has_transcript: false,
                recoverable_sid: Some("bbbbbbbb-1111-2222-3333-444444444444".into()),
                ..session("/n/notes.md")
            }],
            ..Default::default()
        };
        let f = findings(&snap);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].kind, KIND_FRONTMATTER_SID);
        assert!(f[0].repair.is_some());
    }

    /// Ageing: the id is dead and nothing survives on the same notes. There is no repair
    /// — reporting it as one would put 46 false defects on her first scan.
    #[test]
    fn a_dead_id_with_no_survivor_is_not_a_finding() {
        let snap = Snapshot {
            sessions: vec![SessionFacts {
                fm_sid: Some("aaaaaaaa-1111-2222-3333-444444444444".into()),
                fm_sid_has_transcript: false,
                recoverable_sid: None,
                ..session("/n/notes.md")
            }],
            aged_ids: 46,
            ..Default::default()
        };
        let f = findings(&snap);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].kind, KIND_AGED);
        assert!(f[0].repair.is_none(), "ageing is reported, never repaired");
    }

    #[test]
    fn a_missing_notes_file_reports_only_the_orphan() {
        let snap = Snapshot {
            sessions: vec![SessionFacts {
                notes_exists: false,
                status: "archived".into(),
                live_pids: vec![42],
                ..session("/gone/notes.md")
            }],
            ..Default::default()
        };
        let f = findings(&snap);
        assert_eq!(f.len(), 1, "no further check can read a file that is not there");
        assert_eq!(f[0].kind, KIND_REGISTRY_ORPHAN);
    }

    /// The session she hit: `/close-session` ran, the terminal stayed open, and Resume
    /// then refused the only session she could see.
    #[test]
    fn closed_with_a_live_pid_is_broken_too() {
        let snap = Snapshot {
            sessions: vec![SessionFacts {
                status: "closed".into(),
                live_pids: vec![77570],
                ..session("/n/notes.md")
            }],
            ..Default::default()
        };
        let f = findings(&snap);
        assert_eq!(f[0].kind, KIND_FINISHED_ALIVE);
        assert!(f[0].title.contains("Closed"));
        assert!(f[0].repair.is_some());
    }

    #[test]
    fn a_closed_session_with_no_live_pid_is_left_alone() {
        let snap = Snapshot {
            sessions: vec![SessionFacts { status: "closed".into(), ..session("/n/notes.md") }],
            ..Default::default()
        };
        assert!(findings(&snap).is_empty(), "an ordinary closed session is not a defect");
    }

    #[test]
    fn archived_with_a_live_pid_is_broken() {
        let snap = Snapshot {
            sessions: vec![SessionFacts {
                status: "archived".into(),
                live_pids: vec![77570],
                ..session("/n/notes.md")
            }],
            ..Default::default()
        };
        let f = findings(&snap);
        assert_eq!(f[0].kind, KIND_FINISHED_ALIVE);
        assert!(f[0].title.contains("Archived"));
        assert!(f[0].detail.contains("77570"));
    }

    #[test]
    fn an_archived_session_with_no_live_pid_is_left_alone() {
        let snap = Snapshot {
            sessions: vec![SessionFacts { status: "archived".into(), ..session("/n/notes.md") }],
            ..Default::default()
        };
        assert!(findings(&snap).is_empty());
    }

    #[test]
    fn drifted_skills_are_reported_without_a_repair() {
        let snap = Snapshot { drifted_skills: vec!["skills-review".into()], ..Default::default() };
        let f = findings(&snap);
        assert_eq!(f[0].kind, KIND_SKILL_DRIFT);
        assert!(f[0].repair.is_none(), "Doctor must not overwrite a hand-edit");
    }

    #[test]
    fn broken_sorts_ahead_of_untidy_and_info() {
        let snap = Snapshot {
            sessions: vec![SessionFacts { notes_exists: false, ..session("/gone/notes.md") }],
            stale_pidfiles: vec!["/s/1.json".into()],
            drifted_skills: vec!["learn".into()],
            unregistered_live: Vec::new(),
            aged_ids: 3,
        };
        let got = findings(&snap);
        let sev: Vec<&str> = got.iter().map(|f| f.severity.as_str()).collect();
        assert_eq!(sev, ["broken", "untidy", "info", "info"]);
    }

    #[test]
    fn every_id_round_trips_to_its_kind_and_target() {
        let snap = Snapshot {
            sessions: vec![SessionFacts { notes_exists: false, ..session("/gone/notes.md") }],
            stale_pidfiles: vec!["/s/1.json".into()],
            ..Default::default()
        };
        for f in findings(&snap) {
            let (kind, target) = f.id.split_once(':').expect("id is kind:target");
            assert_eq!(kind, f.kind);
            assert_eq!(target, f.target);
        }
    }
}

// ---------------------------------------------------------------------------
// Gathering the facts, and applying what the user picked.
// ---------------------------------------------------------------------------

fn sessions_dir() -> PathBuf {
    crate::config::home().join(".claude").join("sessions")
}

/// Live pids per notes.md, the pidfiles whose process has exited, and the live sessions
/// the registry has no entry for. `dir` is a parameter so the scan can be exercised
/// against a fixture directory — the real one holds whatever is running right now.
///
/// A pidfile is named for the pid that wrote it, so a dead one is residue from a session
/// that ended without cleaning up — harmless, but it is what makes `~/.claude/sessions/`
/// unreadable after a few months.
fn scan_pidfiles(
    dir: &Path,
    active: &Value,
) -> (std::collections::HashMap<String, Vec<i64>>, Vec<String>, Vec<(i64, String)>) {
    let mut live: std::collections::HashMap<String, Vec<i64>> = std::collections::HashMap::new();
    let mut stale = Vec::new();
    let mut orphaned = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (live, stale, orphaned);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(pid) = stem.parse::<i64>() else { continue };
        if !crate::reader::alive(pid) {
            stale.push(path.to_string_lossy().into_owned());
            continue;
        }
        // Alive: attribute it to the notes.md the registry has for its session id.
        let meta = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<Value>(&c).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let entry = meta
            .get("sessionId")
            .and_then(Value::as_str)
            .and_then(|s| active.get(s))
            .and_then(|e| e.get("notes_path").and_then(Value::as_str));
        match entry {
            Some(np) => live.entry(np.to_string()).or_default().push(pid),
            // Background helpers are not sessions the user navigates to — only a real
            // one going unreachable is worth reporting.
            None if !meta.get("background").and_then(Value::as_bool).unwrap_or(false) => {
                let cwd = meta.get("cwd").and_then(Value::as_str).unwrap_or("an unknown folder");
                orphaned.push((pid, cwd.to_string()));
            }
            None => {}
        }
    }
    stale.sort();
    orphaned.sort();
    (live, stale, orphaned)
}

/// Read the store and turn it into the facts [`findings`] classifies.
pub fn snapshot() -> Snapshot {
    let active = crate::reader::load_active_sessions();
    let (live_pids, stale_pidfiles, unregistered_live) = scan_pidfiles(&sessions_dir(), &active);

    // One SessionFacts per notes.md, not per registry entry: several ids sharing a
    // notes.md is the Resume fallback, so the file — not the id — is the unit of repair.
    let mut by_notes: std::collections::BTreeMap<String, Vec<String>> = Default::default();
    if let Some(map) = active.as_object() {
        for (sid, e) in map {
            if let Some(np) = e.get("notes_path").and_then(Value::as_str) {
                by_notes.entry(np.to_string()).or_default().push(sid.clone());
            }
        }
    }

    let mut aged_ids = 0;
    let mut sessions = Vec::new();
    for (notes_path, sids) in by_notes {
        let exists = Path::new(&notes_path).is_file();
        let content = if exists { std::fs::read_to_string(&notes_path).unwrap_or_default() } else { String::new() };
        let recoverable = crate::reader::latest_resumable_sid(&notes_path, &active);

        // Ageing is counted over registered ids, not over files: an id whose transcript
        // is gone while a sibling still has one is already covered by the fallback.
        for sid in &sids {
            if crate::reader::is_resumable_sid(sid)
                && !crate::reader::has_transcript(sid)
                && recoverable.is_none()
            {
                aged_ids += 1;
            }
        }

        let fm_sid = crate::reader::parse_frontmatter(&content)
            .get("session_id")
            .filter(|s| crate::reader::is_resumable_sid(s))
            .cloned();
        sessions.push(SessionFacts {
            fm_sid_has_transcript: fm_sid.as_deref().is_some_and(crate::reader::has_transcript),
            fm_sid,
            recoverable_sid: recoverable,
            status: if exists { crate::reader::session_history_info(&content).0 } else { String::new() },
            live_pids: live_pids.get(&notes_path).cloned().unwrap_or_default(),
            notes_exists: exists,
            notes_path,
        });
    }

    Snapshot {
        sessions,
        stale_pidfiles,
        unregistered_live,
        drifted_skills: crate::skills::drifted_skills(),
        aged_ids,
    }
}

/// Everything Doctor can see. Read-only — no repair happens until [`doctor_repair`] is
/// called with ids the user picked.
#[tauri::command(async)]
pub fn doctor_scan() -> Vec<Finding> {
    findings(&snapshot())
}

/// Rewrite the frontmatter `session_id:` line. Pure, so the substitution is testable
/// away from the filesystem; returns None when there is no such line to replace (the
/// caller then reports the finding as unrepaired rather than appending a stray key).
pub fn rewrite_session_id(content: &str, sid: &str) -> Option<String> {
    let block = crate::reader::frontmatter_block(content)?;
    let line = block.lines().find(|l| {
        !crate::reader::is_frontmatter_list_item(l)
            && l.split_once(':').is_some_and(|(k, _)| k.trim() == "session_id")
    })?;
    let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
    Some(content.replacen(line, &format!("{indent}session_id: {sid}"), 1))
}

fn now_stamp() -> String {
    crate::local_date_time().map(|(d, t)| format!("{d} {t}")).unwrap_or_default()
}

/// Make a notes file read as work in progress again — the repair for a session the notes
/// call finished while its process is still running.
///
/// Both halves are needed, and stripping alone is the bug they fix: archiving from Closed
/// leaves the close entry underneath, so removing the ARCHIVED marker only uncovers it
/// and `session_history_info` reads "closed" on the very next scan. The finding then
/// reappears and the repair asks to be clicked twice. So: drop the marker, and if what
/// surfaces still does not read as open, append an in-progress entry — the same line
/// `/save-session` writes. Additive; no existing history line is ever rewritten.
pub fn reopen(content: &str, when: &str) -> String {
    let stripped = crate::strip_archived(content);
    if crate::reader::session_history_info(&stripped).0 == "stale" {
        return stripped;
    }
    let line = format!("- {when} (in progress) | reopened by Doctor — the session process is still running");
    crate::stamp_archived(&stripped, &line)
}

/// Apply the repairs the user selected, by finding id. Each is attempted independently:
/// one failure names itself in the report and does not stop the others.
#[tauri::command(async)]
pub fn doctor_repair(ids: Vec<String>) -> Value {
    let active = crate::reader::load_active_sessions();
    let mut fixed = Vec::new();
    let mut failed = Vec::new();

    for id in ids {
        let Some((kind, target)) = id.split_once(':') else {
            failed.push(serde_json::json!({ "id": id, "error": "unknown finding" }));
            continue;
        };
        let outcome: Result<(), String> = match kind {
            KIND_PIDFILE_STALE => {
                // Confined to ~/.claude/sessions/<pid>.json — the id came from our own
                // scan, but it arrives back over IPC, so it is re-checked, not trusted.
                let p = Path::new(target);
                if p.parent() != Some(sessions_dir().as_path()) {
                    Err("not a session pidfile".into())
                } else if crate::reader::alive(
                    p.file_stem().and_then(|s| s.to_str()).and_then(|s| s.parse().ok()).unwrap_or(0),
                ) {
                    Err("that process is running again".into())
                } else {
                    std::fs::remove_file(p).map_err(|e| e.to_string())
                }
            }
            KIND_REGISTRY_ORPHAN => {
                if Path::new(target).exists() {
                    Err("the notes.md is back — nothing to drop".into())
                } else {
                    crate::remove_registry_entries_for(target)
                }
            }
            KIND_FRONTMATTER_SID => crate::notes_md_under_root(target).and_then(|abs| {
                let sid = crate::reader::latest_resumable_sid(target, &active)
                    .ok_or("no surviving conversation to point at")?;
                let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
                let next = rewrite_session_id(&content, &sid).ok_or("no session_id in the frontmatter")?;
                crate::atomic_write(&abs, &next)
            }),
            KIND_FINISHED_ALIVE => crate::notes_md_under_root(target).and_then(|abs| {
                let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
                crate::atomic_write(&abs, &reopen(&content, &now_stamp()))
                    .and_then(|()| Ok(()))
            }),
            _ => Err("this finding has no repair".into()),
        };
        match outcome {
            Ok(()) => fixed.push(id),
            Err(e) => failed.push(serde_json::json!({ "id": id, "error": e })),
        }
    }
    serde_json::json!({ "fixed": fixed, "failed": failed })
}

#[cfg(test)]
mod io_tests {
    use super::*;

    #[test]
    fn rewrites_the_session_id_line_in_place() {
        let before = "---\nname: x\nsession_id: dead-one\nticket: T-1\n---\n\n# Body\n";
        let after = rewrite_session_id(before, "live-one").unwrap();
        assert!(after.contains("session_id: live-one"));
        assert!(after.contains("name: x") && after.contains("ticket: T-1"));
        assert!(after.ends_with("# Body\n"), "body untouched");
    }

    /// Archiving from Closed stacks a marker on top of a close entry. Stripping the
    /// marker alone uncovers the close line, so the scan reports the same defect again —
    /// the repair has to land in one click.
    #[test]
    fn reopening_an_archived_session_clears_the_close_underneath_it() {
        let notes = "# S\n\n## Session history\n- 2026-01-02 10:00 | session=abc | did the work\n- 2026-02-01 09:00 | ARCHIVED | archived from the dashboard\n";
        let once = reopen(notes, "2026-09-04 12:00");
        assert!(!once.contains("ARCHIVED"));
        assert_eq!(crate::reader::session_history_info(&once).0, "stale", "one repair is enough");
        assert_eq!(reopen(&once, "2026-09-04 12:01"), once, "and it is idempotent");
    }

    /// An archived session whose history was already open needs no new line — the marker
    /// was the whole problem.
    #[test]
    fn reopening_only_strips_the_marker_when_that_suffices() {
        let notes = "# S\n\n## Session history\n- 2026-01-02 10:00 (in progress) | session=abc | working\n- 2026-02-01 09:00 | ARCHIVED | archived from the dashboard\n";
        let out = reopen(notes, "2026-09-04 12:00");
        assert!(!out.contains("ARCHIVED"));
        assert!(!out.contains("reopened by Doctor"), "nothing to add");
    }

    #[test]
    fn reopening_a_closed_session_appends_an_in_progress_entry() {
        let notes = "# S\n\n## Session history\n- 2026-01-02 10:00 | session=abc | wrapped up\n";
        let out = reopen(notes, "2026-09-04 12:00");
        assert!(out.contains("2026-09-04 12:00 (in progress)"));
        assert!(out.contains("wrapped up"), "the existing log is kept");
        assert_eq!(crate::reader::session_history_info(&out).0, "stale");
    }

    #[test]
    fn leaves_a_frontmatter_without_a_session_id_alone() {
        assert_eq!(rewrite_session_id("---\nname: x\n---\n", "live"), None);
        assert_eq!(rewrite_session_id("no frontmatter at all\n", "live"), None);
    }

    /// A `session_id` inside the body must not be mistaken for the frontmatter's.
    #[test]
    fn only_the_frontmatter_line_is_touched() {
        let before = "---\nsession_id: dead\n---\n\nsession_id: dead was the old one\n";
        let after = rewrite_session_id(before, "live").unwrap();
        assert!(after.starts_with("---\nsession_id: live\n---"));
        assert!(after.contains("session_id: dead was the old one"));
    }
}

/// Run the real scan against the real store. Ignored by default (it reads the machine's
/// `~/.claude`, so it is a diagnostic, not a unit test) — `cargo test -- --ignored
/// real_store` prints what a user would see. Kept in the tree because the classifier was
/// calibrated against a real 113-session store, and a rule that only ever meets fixtures
/// drifts away from the data it was written for.
#[test]
#[ignore]
fn real_store_scan() {
    let snap = snapshot();
    eprintln!(
        "sessions={} stale_pidfiles={} drifted_skills={:?} aged={}",
        snap.sessions.len(), snap.stale_pidfiles.len(), snap.drifted_skills, snap.aged_ids
    );
    for f in findings(&snap) {
        eprintln!("[{}] {} — {}\n      {}", f.severity, f.kind, f.title, f.detail);
    }
}

#[cfg(test)]
mod unregistered_tests {
    use super::*;

    /// The session she hit today: closed in the list, "already active" on Resume. The
    /// process is real and the registry cannot see it, so no other check finds it.
    #[test]
    fn a_live_session_outside_the_registry_is_reported_with_its_pid() {
        let snap = Snapshot {
            unregistered_live: vec![(77570, "/Users/t/repo".into())],
            ..Default::default()
        };
        let f = findings(&snap);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].kind, KIND_LIVE_UNREGISTERED);
        assert!(f[0].detail.contains("77570") && f[0].detail.contains("/Users/t/repo"));
        assert!(f[0].repair.is_none(), "Doctor never kills a running terminal");
    }
}

#[cfg(test)]
mod pidfile_tests {
    use super::*;
    use serde_json::json;

    /// Same idiom as skills.rs: a per-process temp dir, cleared on entry so a rerun
    /// after a failure starts from nothing.
    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ao-doctor-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, pid: u32, body: Value) {
        std::fs::write(dir.join(format!("{pid}.json")), body.to_string()).unwrap();
    }

    /// The only pid guaranteed alive during the test is the test process itself, and the
    /// only one guaranteed dead is one that cannot be allocated — so those are what the
    /// fixture uses rather than numbers that happen to be free today.
    #[test]
    fn a_live_pidfile_is_attributed_to_its_registered_notes() {
        let dir = tmp("registered");
        let me = std::process::id();
        write(&dir, me, json!({ "sessionId": "sid-a", "cwd": "/w" }));
        let active = json!({ "sid-a": { "notes_path": "/n/notes.md" } });

        let (live, stale, orphaned) = scan_pidfiles(&dir, &active);
        assert_eq!(live.get("/n/notes.md"), Some(&vec![me as i64]));
        assert!(stale.is_empty() && orphaned.is_empty());
    }

    #[test]
    fn a_live_pidfile_with_no_registry_entry_is_reported_unregistered() {
        let dir = tmp("unregistered");
        let me = std::process::id();
        write(&dir, me, json!({ "sessionId": "sid-gone", "cwd": "/some/repo" }));

        let (live, _, orphaned) = scan_pidfiles(&dir, &json!({}));
        assert!(live.is_empty());
        assert_eq!(orphaned, vec![(me as i64, "/some/repo".to_string())]);
    }

    /// Background helpers are not sessions anyone navigates to; reporting them as
    /// unreachable work would be noise on every scan.
    #[test]
    fn a_background_helper_is_not_reported() {
        let dir = tmp("background");
        write(&dir, std::process::id(), json!({ "sessionId": "x", "background": true, "cwd": "/w" }));
        let (_, _, orphaned) = scan_pidfiles(&dir, &json!({}));
        assert!(orphaned.is_empty());
    }

    #[test]
    fn a_pidfile_whose_process_is_gone_is_residue() {
        let dir = tmp("stale");
        // Above the pid_max any macOS or Linux kernel will hand out, so it cannot be live.
        write(&dir, 4_294_000_000, json!({ "sessionId": "sid-old", "cwd": "/w" }));
        let (live, stale, orphaned) = scan_pidfiles(&dir, &json!({}));
        assert_eq!(stale.len(), 1);
        assert!(stale[0].ends_with("4294000000.json"));
        assert!(live.is_empty() && orphaned.is_empty());
    }

    #[test]
    fn non_pidfiles_are_ignored() {
        let dir = tmp("junk");
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        std::fs::write(dir.join("not-a-pid.json"), "{}").unwrap();
        let (live, stale, orphaned) = scan_pidfiles(&dir, &json!({}));
        assert!(live.is_empty() && stale.is_empty() && orphaned.is_empty());
    }

    #[test]
    fn a_missing_sessions_dir_is_not_an_error() {
        let (live, stale, orphaned) = scan_pidfiles(Path::new("/no/such/dir"), &json!({}));
        assert!(live.is_empty() && stale.is_empty() && orphaned.is_empty());
    }
}
