//! In-app session-skills installer.
//!
//! The session skills (`/start-session`, `/close-session`, …) only work when they
//! live in `~/.claude/skills/` — Claude Code never reads them from inside the app
//! bundle. So the bundle merely *carries* them: `include_dir!` embeds `../skills`
//! into the binary at compile time, and this module copies them out to
//! `~/.claude/skills/` on request. That makes a `.dmg`-only install self-sufficient
//! (no git clone + `install.sh` needed) and lets the app refresh the skills after an
//! upgrade.
//!
//! This is the one place the app writes under `~/.claude` besides the two explicit
//! session-data writes (archive, PR link), and it only ever touches
//! `~/.claude/skills/` (app-owned lifecycle skills), never session transcripts.
//!
//! Embedding via `include_dir!` (rather than Tauri `bundle.resources`) means the
//! path resolves identically in `tauri dev` and the bundled app — no resource-dir
//! divergence, no `_up_` path rewriting.

use crate::config;
use include_dir::{include_dir, Dir};
use serde::Serialize;
use std::fs;
use std::path::Path;

/// The repo's `skills/` directory, embedded at compile time.
static SKILLS: Dir = include_dir!("$CARGO_MANIFEST_DIR/../skills");

/// `lib/` is the shared Python helper — app-owned, always refreshed (never a
/// user-customised skill), and not itself a slash-command.
const SHARED_LIB: &str = "lib";

/// Name of the marker `install_into` leaves in the destination once every skill dir
/// there genuinely matches this bundle. Read back by `skills_status()` to tell "the
/// bundle is newer" from "it's just different" — an app upgrade isn't the only way
/// `~/.claude/skills` moves forward; `scripts/install.sh --force` stamps the same file,
/// so a build that shipped before a fix landed can tell it would go backward.
const MANIFEST_FILE: &str = ".ao-install-manifest.json";

/// Unix seconds of the last commit that touched `skills/` in the tree this binary was
/// built from, baked in by `build.rs`. `0` means unknown (no `.git`, or the lookup
/// failed) — never treated as "very old", only as "can't compare".
fn bundle_epoch() -> i64 {
    option_env!("AO_SKILLS_BUNDLE_EPOCH").and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// The `bundle_epoch` recorded the last time `dst`'s skills were confirmed to match a
/// bundle in full, or `None` if it was never stamped (older app, fresh `install.sh`
/// without this feature, or a stamp that failed to parse — all read as "can't compare").
fn read_installed_epoch(dst: &Path) -> Option<i64> {
    let raw = fs::read_to_string(dst.join(MANIFEST_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("bundle_epoch")?.as_i64()
}

/// Stamp `dst` as matching `epoch`. Best-effort: a failed write leaves the previous
/// (or absent) marker, which only ever makes the next check MORE conservative, never
/// less — so it's safe to ignore the error here.
fn write_installed_epoch(dst: &Path, epoch: i64) {
    let body = serde_json::json!({ "bundle_epoch": epoch }).to_string();
    let _ = fs::write(dst.join(MANIFEST_FILE), body);
}

#[derive(Serialize)]
pub struct InstallReport {
    /// Skill dirs written this run (always includes `lib`).
    pub installed: Vec<String>,
    /// Skill dirs left untouched because they existed and `force` was false.
    pub skipped: Vec<String>,
    /// Whether a default config.json was seeded (absent before).
    pub config_seeded: bool,
    /// Category base dirs created (absent before).
    pub dirs_created: Vec<String>,
}

#[derive(Serialize)]
pub struct SkillsStatus {
    /// True when every bundled slash-command skill is present in `~/.claude/skills`.
    pub installed: bool,
    pub present: Vec<String>,
    pub missing: Vec<String>,
    /// Present skills whose on-disk content differs from the bundled version — i.e. the
    /// ones a force-install would actually change (e.g. a user's customised copy). Lets
    /// the UI warn precisely before overwriting.
    pub differs: Vec<String>,
    /// This build's own skills, dated (unix seconds of the last commit touching
    /// `skills/`; `0` = unknown).
    pub bundle_epoch: i64,
    /// When `~/.claude/skills` was last confirmed to fully match SOME bundle (this
    /// app's or `install.sh`'s), or `None` if never stamped. Compared against
    /// `bundle_epoch` so the UI can tell "this install would go backward" from "this is
    /// a real update" instead of just "these differ".
    pub installed_epoch: Option<i64>,
}

/// The slash-command skill names the bundle carries (excludes the shared `lib`).
#[cfg(test)]
fn skill_names() -> Vec<String> {
    let mut names: Vec<String> = SKILLS
        .dirs()
        .filter_map(|d| d.path().file_name().map(|n| n.to_string_lossy().into_owned()))
        .filter(|n| n != SHARED_LIB)
        .collect();
    names.sort();
    names
}

/// True if `dir`'s embedded content differs from what's on disk at `target` (a missing
/// or byte-different file counts as differing). One-directional: it answers "would
/// re-extracting the bundle change these files?", which is what a force-install does.
fn dir_differs(dir: &Dir, target: &Path) -> bool {
    for f in dir.files() {
        if let Some(name) = f.path().file_name() {
            match fs::read(target.join(name)) {
                Ok(bytes) if bytes == f.contents() => {}
                _ => return true,
            }
        }
    }
    for d in dir.dirs() {
        if let Some(name) = d.path().file_name() {
            if dir_differs(d, &target.join(name)) {
                return true;
            }
        }
    }
    false
}

/// Recursively write `dir`'s *contents* into `target` (files by basename, subdirs
/// recursed into `target/<subname>`).
fn extract_into(dir: &Dir, target: &Path) -> std::io::Result<()> {
    fs::create_dir_all(target)?;
    for f in dir.files() {
        if let Some(name) = f.path().file_name() {
            fs::write(target.join(name), f.contents())?;
        }
    }
    for d in dir.dirs() {
        if let Some(name) = d.path().file_name() {
            extract_into(d, &target.join(name))?;
        }
    }
    Ok(())
}

/// Copy the embedded skills into `dst` (= `~/.claude/skills`).
/// - `lib/` is always refreshed (app-owned helper).
/// - a skill dir that already exists is skipped unless `force` (then overwritten).
/// - when nothing was skipped, `dst` is stamped with `epoch` — the tree genuinely
///   matches this bundle everywhere, which is the only time that claim is true. A
///   partial (non-force) install over an existing tree leaves the previous stamp (or
///   none) alone rather than claim a match that isn't there.
///
/// Returns `(installed, skipped)` skill-dir names. Pure I/O on `dst` so it's unit-
/// testable against a temp dir.
fn install_into(dst: &Path, force: bool, epoch: i64) -> std::io::Result<(Vec<String>, Vec<String>)> {
    let mut installed = Vec::new();
    let mut skipped = Vec::new();
    fs::create_dir_all(dst)?;
    for d in SKILLS.dirs() {
        let Some(name) = d.path().file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let target = dst.join(&name);
        // The shared helper is app-owned: always refresh it (mirrors install.sh).
        if name == SHARED_LIB {
            extract_into(d, &target)?;
            installed.push(name);
            continue;
        }
        if target.exists() && !force {
            skipped.push(name);
            continue;
        }
        if target.exists() {
            fs::remove_dir_all(&target)?;
        }
        extract_into(d, &target)?;
        installed.push(name);
    }
    installed.sort();
    skipped.sort();
    if skipped.is_empty() {
        write_installed_epoch(dst, epoch);
    }
    Ok((installed, skipped))
}

/// Install (or, with `force`, refresh) the bundled skills into `~/.claude/skills`,
/// seed a default config if none exists, and pre-create the category folders.
#[tauri::command]
pub fn install_skills(force: bool) -> Result<InstallReport, String> {
    let dst = config::home().join(".claude").join("skills");
    let (installed, skipped) = install_into(&dst, force, bundle_epoch()).map_err(|e| e.to_string())?;
    let config_seeded = config::seed_default_if_absent()?;
    let mut dirs_created = Vec::new();
    for base in config::category_base_dirs() {
        if !base.exists() && fs::create_dir_all(&base).is_ok() {
            dirs_created.push(base.to_string_lossy().into_owned());
        }
    }
    Ok(InstallReport { installed, skipped, config_seeded, dirs_created })
}

/// Which bundled skills are already installed — drives the first-launch banner.
#[tauri::command]
pub fn skills_status() -> SkillsStatus {
    let dst = config::home().join(".claude").join("skills");
    let (mut present, mut missing, mut differs) = (Vec::new(), Vec::new(), Vec::new());
    for d in SKILLS.dirs() {
        let Some(name) = d.path().file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if name == SHARED_LIB {
            continue; // not a slash-command skill
        }
        let target = dst.join(&name);
        if !target.exists() {
            missing.push(name);
            continue;
        }
        if dir_differs(d, &target) {
            differs.push(name.clone());
        }
        present.push(name);
    }
    present.sort();
    missing.sort();
    differs.sort();
    SkillsStatus {
        installed: missing.is_empty(),
        present,
        missing,
        differs,
        bundle_epoch: bundle_epoch(),
        installed_epoch: read_installed_epoch(&dst),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ao-skills-{}-{}", std::process::id(), tag));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn bundle_carries_the_slash_command_skills() {
        let names = skill_names();
        for expected in [
            "start-session",
            "close-session",
            "save-session",
            "restart-session",
            "archive-session",
            "import-session",
            "rename-category",
        ] {
            assert!(names.contains(&expected.to_string()), "missing bundled skill: {expected}");
        }
        assert!(!names.contains(&"lib".to_string()), "lib is not a slash-command skill");
    }

    #[test]
    fn install_writes_every_skill_plus_the_shared_lib() {
        let dst = tmp("fresh");
        let (installed, skipped) = install_into(&dst, false, 100).unwrap();
        assert!(skipped.is_empty());
        assert!(installed.contains(&"lib".to_string()));
        // A representative skill file and a shared-lib file landed on disk.
        assert!(dst.join("start-session/SKILL.md").exists());
        assert!(dst.join("lib").read_dir().unwrap().any(|e| {
            e.unwrap().path().extension().map(|x| x == "py").unwrap_or(false)
        }));
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn existing_skill_is_skipped_without_force_and_overwritten_with_it() {
        let dst = tmp("force");
        // Pre-seed a customised skill dir with a sentinel that a non-force install must keep.
        let skill = dst.join("start-session");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), b"USER EDIT").unwrap();

        let (installed, skipped) = install_into(&dst, false, 100).unwrap();
        assert!(skipped.contains(&"start-session".to_string()));
        assert!(!installed.contains(&"start-session".to_string()));
        assert_eq!(fs::read(skill.join("SKILL.md")).unwrap(), b"USER EDIT");

        let (installed, _) = install_into(&dst, true, 100).unwrap();
        assert!(installed.contains(&"start-session".to_string()));
        assert_ne!(fs::read(skill.join("SKILL.md")).unwrap(), b"USER EDIT");
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn dir_differs_detects_tampering_and_missing() {
        let dst = tmp("differs");
        install_into(&dst, false, 100).unwrap();
        let start = SKILLS.get_dir("start-session").expect("bundled start-session");
        // Fresh extract is byte-identical → no diff.
        assert!(!dir_differs(start, &dst.join("start-session")));
        // A user edit is detected.
        fs::write(dst.join("start-session/SKILL.md"), b"EDITED").unwrap();
        assert!(dir_differs(start, &dst.join("start-session")));
        // A missing target counts as differing (force would create it).
        assert!(dir_differs(start, &dst.join("nope")));
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn lib_is_refreshed_even_without_force() {
        let dst = tmp("lib");
        let lib = dst.join("lib");
        fs::create_dir_all(&lib).unwrap();
        fs::write(lib.join("aoconfig.py"), b"STALE").unwrap();
        let (installed, _) = install_into(&dst, false, 100).unwrap();
        assert!(installed.contains(&"lib".to_string()));
        assert_ne!(fs::read(lib.join("aoconfig.py")).unwrap(), b"STALE");
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn a_complete_install_stamps_the_epoch() {
        let dst = tmp("stamp-complete");
        // Fresh (nothing skipped) and force (nothing skipped either) both leave the
        // tree fully matching the bundle — both must stamp.
        install_into(&dst, false, 555).unwrap();
        assert_eq!(read_installed_epoch(&dst), Some(555));
        install_into(&dst, true, 777).unwrap();
        assert_eq!(read_installed_epoch(&dst), Some(777));
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn a_partial_install_does_not_stamp_a_false_match() {
        let dst = tmp("stamp-partial");
        let skill = dst.join("start-session");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), b"USER EDIT").unwrap();
        // Non-force over an existing skill skips it — the tree does NOT fully match
        // the bundle, so claiming epoch 555 here would be a lie the next check believes.
        let (_, skipped) = install_into(&dst, false, 555).unwrap();
        assert!(!skipped.is_empty());
        assert_eq!(read_installed_epoch(&dst), None);
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn missing_or_corrupt_manifest_reads_as_unknown() {
        let dst = tmp("manifest-corrupt");
        fs::create_dir_all(&dst).unwrap();
        assert_eq!(read_installed_epoch(&dst), None, "no manifest at all");
        fs::write(dst.join(MANIFEST_FILE), b"not json").unwrap();
        assert_eq!(read_installed_epoch(&dst), None, "unparsable manifest");
        fs::write(dst.join(MANIFEST_FILE), b"{}").unwrap();
        assert_eq!(read_installed_epoch(&dst), None, "manifest missing the key");
        let _ = fs::remove_dir_all(&dst);
    }
}
