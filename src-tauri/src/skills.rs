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

/// Where the pristine snapshots live — one copy of each skill, as it stood the last
/// time an installer wrote it. Sibling of `.archive/` (already under
/// `~/.claude/skills/`, already excluded from every `*/SKILL.md` glob and from the
/// bundle's own directory iteration, since neither name is a skill this bundle carries).
///
/// The app's skills are app-owned — a sync overwrites them without asking, the way any
/// app refreshes its own resources. The base exists for exactly one reason: detecting
/// that someone edited a skill by hand anyway, so the sync can move that edit to
/// `.archive/` instead of destroying it. Nothing is ever merged; nothing is ever lost.
const BASE_DIR: &str = ".ao-base";

/// Where a hand-edited skill's copy goes right before a sync overwrites it. `.archive/`
/// is the same place `/skills-review` already moves retired skills — one recovery
/// location, not two.
const ARCHIVE_DIR: &str = ".archive";

/// Has this skill been edited outside the installers since the last time one wrote it?
/// No base at all counts as edited — for a skill that differs from the bundle with no
/// recorded history, backing up before overwriting costs a few kilobytes; guessing
/// wrong costs someone's work.
fn hand_edited(base: &Path, target: &Path) -> bool {
    !base.exists() || paths_differ(base, target)
}

/// True if the file trees at `a` and `b` differ in any way — an extra file on either
/// side, a missing one, or different bytes. Both sides are read fully into memory as
/// relative-path → bytes maps and compared; skill directories are small (a `SKILL.md`
/// plus maybe a `references/` folder), so this is not a concern at this scale.
fn paths_differ(a: &Path, b: &Path) -> bool {
    fn snapshot(root: &Path) -> std::collections::BTreeMap<std::path::PathBuf, Vec<u8>> {
        fn walk(dir: &Path, root: &Path, out: &mut std::collections::BTreeMap<std::path::PathBuf, Vec<u8>>) {
            let Ok(entries) = fs::read_dir(dir) else { return };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    walk(&path, root, out);
                } else if let (Ok(rel), Ok(bytes)) = (path.strip_prefix(root), fs::read(&path)) {
                    out.insert(rel.to_path_buf(), bytes);
                }
            }
        }
        let mut out = std::collections::BTreeMap::new();
        walk(root, root, &mut out);
        out
    }
    snapshot(a) != snapshot(b)
}

/// Replace `dst`'s base snapshot for a skill with the bundle's current content.
/// Best-effort, mirroring `write_installed_epoch`: a failed write just leaves the
/// previous (or absent) base, which only makes the next hand-edit check MORE cautious.
fn refresh_base(bundle_dir: &Dir, base: &Path) {
    let _ = fs::remove_dir_all(base);
    let _ = extract_into(bundle_dir, base);
}

/// Copy the file tree at `src` into `dst` (created fresh). Used to preserve a
/// hand-edited skill in `.archive/` before a sync overwrites it.
fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)?.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_tree(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
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
    /// `bundle_epoch` — that comparison is what stops an app built before the latest
    /// `install.sh --force` run from reverting the tree at launch.
    pub installed_epoch: Option<i64>,
}

/// The slash-command skill names the bundle carries (excludes the shared `lib`).
/// Installed skills that no longer match their `.ao-base` snapshot — someone edited them
/// by hand since the last install. Reported by Doctor, never acted on there: the sync
/// path already archives a hand-edit before overwriting it, and that is the only place
/// allowed to touch one.
pub fn drifted_skills() -> Vec<String> {
    let dst = config::home().join(".claude").join("skills");
    let mut out: Vec<String> = SKILLS
        .dirs()
        .filter_map(|d| d.path().file_name().map(|n| n.to_string_lossy().into_owned()))
        .filter(|n| n != SHARED_LIB)
        .filter(|n| dst.join(n).exists() && hand_edited(&dst.join(BASE_DIR).join(n), &dst.join(n)))
        .collect();
    out.sort();
    out
}

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
        // Whichever path wrote this skill, disk now equals the bundle — the base for
        // future 3-way comparisons (update_into) must equal it too, or a later smart
        // update would misjudge this skill as locally-patched relative to a stale base.
        refresh_base(d, &dst.join(BASE_DIR).join(&name));
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
    let mut present = Vec::new();
    let mut missing = Vec::new();
    let mut differs = Vec::new();
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

/// One hand-edited skill a sync preserved before overwriting.
#[derive(Serialize)]
pub struct BackedUp {
    pub name: String,
    /// Where the pre-overwrite copy went, absolute — printed so the user can find it.
    pub backup: String,
}

/// Report from `sync_skills()`.
#[derive(Serialize)]
pub struct SyncReport {
    /// True when an automatic sync stood down because the on-disk tree is already at
    /// (or past) this bundle's date — the developer-workflow case, where `install.sh`
    /// ran more recently than this app was built. Nothing was touched.
    pub skipped_ahead: bool,
    /// Skills that were missing entirely, installed fresh (always includes `lib`).
    pub installed: Vec<String>,
    /// Present skills overwritten with this bundle's version.
    pub updated: Vec<String>,
    /// The subset of `updated` that had been edited outside the installers — each one's
    /// previous content was copied under `.archive/` first, never destroyed.
    pub backed_up: Vec<BackedUp>,
    pub config_seeded: bool,
    pub dirs_created: Vec<String>,
}

/// Bring `dst`'s app-owned skills to exactly this bundle. The app's skills are product
/// primitives — nobody customises File > Save — so a sync overwrites them without a
/// question, under two rules that make that safe:
///
/// - **Direction**: an automatic sync (`manual == false`) stands down entirely when the
///   epoch manifest says the tree already matches a bundle at least as recent as this
///   one. That is the developer case — `install.sh --force` from a fresher checkout ran
///   after this app was built — and an older binary must not revert it at every launch.
///   A manual sync (the Settings button) skips this guard: the user is explicitly
///   asking for THIS build's versions.
/// - **No silent loss**: a skill whose content doesn't match its `.ao-base/` snapshot
///   was edited outside the installers. Its current content is copied to
///   `.archive/<name>.pre-sync-<unix-ts>/` before the overwrite, and reported.
///
/// What one sync pass did to a skills tree: whether the direction guard stood it down,
/// the skills installed fresh, the ones updated, and the hand-edits copied aside first.
type SyncOutcome = (bool, Vec<String>, Vec<String>, Vec<BackedUp>);

/// Pure I/O on `dst`, unit-testable against a temp dir.
fn sync_into(
    dst: &Path,
    manual: bool,
    epoch: i64,
) -> std::io::Result<SyncOutcome> {
    if !manual {
        if let Some(installed_epoch) = read_installed_epoch(dst) {
            if epoch > 0 && installed_epoch >= epoch {
                return Ok((true, Vec::new(), Vec::new(), Vec::new()));
            }
        }
    }
    let mut installed = Vec::new();
    let mut updated = Vec::new();
    let mut backed_up = Vec::new();
    let base_root = dst.join(BASE_DIR);
    fs::create_dir_all(dst)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for d in SKILLS.dirs() {
        let Some(name) = d.path().file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let target = dst.join(&name);
        if name == SHARED_LIB {
            extract_into(d, &target)?;
            installed.push(name);
            continue;
        }
        if !target.exists() {
            extract_into(d, &target)?;
            refresh_base(d, &base_root.join(&name));
            installed.push(name);
            continue;
        }
        let base = base_root.join(&name);
        if !dir_differs(d, &target) {
            // Every bundled file already matches on disk — nothing to write. Seed the
            // base when this is a pre-tracking install, then move on.
            if !base.exists() {
                refresh_base(d, &base);
            }
            continue;
        }
        if hand_edited(&base, &target) {
            let backup = dst.join(ARCHIVE_DIR).join(format!("{name}.pre-sync-{stamp}"));
            copy_tree(&target, &backup)?;
            backed_up.push(BackedUp { name: name.clone(), backup: backup.to_string_lossy().into_owned() });
        }
        fs::remove_dir_all(&target)?;
        extract_into(d, &target)?;
        refresh_base(d, &base);
        updated.push(name);
    }
    installed.sort();
    updated.sort();
    backed_up.sort_by(|a, b| a.name.cmp(&b.name));
    // The tree now fully matches this bundle — the one situation the stamp may claim.
    write_installed_epoch(dst, epoch);
    Ok((false, installed, updated, backed_up))
}

/// Keep the app-owned skills current. Called automatically at launch (manual=false,
/// direction-guarded) and from Settings (manual=true, this build's versions on demand).
/// Also seeds config/category folders, same as `install_skills`.
#[tauri::command]
pub fn sync_skills(manual: bool) -> Result<SyncReport, String> {
    let dst = config::home().join(".claude").join("skills");
    let (skipped_ahead, installed, updated, backed_up) =
        sync_into(&dst, manual, bundle_epoch()).map_err(|e| e.to_string())?;
    let config_seeded = config::seed_default_if_absent()?;
    let mut dirs_created = Vec::new();
    for base in config::category_base_dirs() {
        if !base.exists() && fs::create_dir_all(&base).is_ok() {
            dirs_created.push(base.to_string_lossy().into_owned());
        }
    }
    Ok(SyncReport { skipped_ahead, installed, updated, backed_up, config_seeded, dirs_created })
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

    // ── hand-edit detection (paths_differ / hand_edited) ──

    #[test]
    fn paths_differ_catches_bytes_extra_and_missing_files() {
        let dst = tmp("paths-differ");
        let a = dst.join("a");
        let b = dst.join("b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        fs::write(a.join("f"), b"same").unwrap();
        fs::write(b.join("f"), b"same").unwrap();
        assert!(!paths_differ(&a, &b), "identical single file");

        fs::write(b.join("f"), b"different").unwrap();
        assert!(paths_differ(&a, &b), "different bytes");

        fs::write(b.join("f"), b"same").unwrap();
        fs::write(b.join("extra"), b"x").unwrap();
        assert!(paths_differ(&a, &b), "extra file on one side");

        let _ = fs::remove_dir_all(&dst);
    }

    // ── sync_into: app-owned skills, direction-guarded, backup-on-hand-edit ──

    #[test]
    fn sync_installs_missing_skills_fresh_and_seeds_their_base() {
        let dst = tmp("sync-fresh");
        let (skipped, installed, updated, backed_up) = sync_into(&dst, false, 100).unwrap();
        assert!(!skipped);
        assert!(installed.contains(&"lib".to_string()));
        assert!(installed.contains(&"start-session".to_string()));
        assert!(updated.is_empty() && backed_up.is_empty());
        assert!(dst.join(BASE_DIR).join("start-session/SKILL.md").exists());
        assert_eq!(read_installed_epoch(&dst), Some(100), "a full sync stamps its epoch");
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn sync_overwrites_a_stale_untouched_skill_without_backup() {
        let dst = tmp("sync-stale");
        sync_into(&dst, false, 100).unwrap(); // base == bundle == disk everywhere
        // Simulate an older install: base and disk agree with each other at an older
        // shared point; the (fixed, embedded) bundle has moved past it.
        fs::write(dst.join(BASE_DIR).join("start-session/SKILL.md"), b"OLDER").unwrap();
        fs::write(dst.join("start-session/SKILL.md"), b"OLDER").unwrap();
        let (_, _, updated, backed_up) = sync_into(&dst, false, 200).unwrap();
        assert!(updated.contains(&"start-session".to_string()));
        assert!(backed_up.is_empty(), "nothing was hand-edited, nothing to preserve");
        let bundle = SKILLS.get_dir("start-session").unwrap();
        assert!(!dir_differs(bundle, &dst.join("start-session")));
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn sync_backs_up_a_hand_edit_before_overwriting() {
        let dst = tmp("sync-hand-edit");
        sync_into(&dst, false, 100).unwrap();
        // A hand edit (or an approved /skill-propose patch): disk moves, base does not.
        fs::write(dst.join("start-session/SKILL.md"), b"MY OWN IMPROVEMENT").unwrap();
        let (_, _, updated, backed_up) = sync_into(&dst, true, 200).unwrap();
        assert!(updated.contains(&"start-session".to_string()));
        let saved = backed_up.iter().find(|b| b.name == "start-session").expect("named in report");
        // The previous content survives, byte for byte, at the reported path.
        assert_eq!(
            fs::read(Path::new(&saved.backup).join("SKILL.md")).unwrap(),
            b"MY OWN IMPROVEMENT"
        );
        // And the skill itself is now the bundle's version.
        let bundle = SKILLS.get_dir("start-session").unwrap();
        assert!(!dir_differs(bundle, &dst.join("start-session")));
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn an_automatic_sync_stands_down_when_the_tree_is_already_ahead() {
        let dst = tmp("sync-ahead");
        sync_into(&dst, false, 300).unwrap(); // stamped at 300
        fs::write(dst.join("start-session/SKILL.md"), b"NEWER, FROM INSTALL.SH").unwrap();
        // An app built earlier (bundle epoch 200) launches: it must not revert this.
        let (skipped, installed, updated, backed_up) = sync_into(&dst, false, 200).unwrap();
        assert!(skipped);
        assert!(installed.is_empty() && updated.is_empty() && backed_up.is_empty());
        assert_eq!(fs::read(dst.join("start-session/SKILL.md")).unwrap(), b"NEWER, FROM INSTALL.SH");
        assert_eq!(read_installed_epoch(&dst), Some(300), "the newer stamp survives");
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn a_manual_sync_ignores_the_direction_guard_but_still_backs_up() {
        let dst = tmp("sync-manual");
        sync_into(&dst, false, 300).unwrap();
        fs::write(dst.join("start-session/SKILL.md"), b"NEWER, FROM INSTALL.SH").unwrap();
        // The user explicitly asks Settings for THIS build's versions (epoch 200).
        let (skipped, _, updated, backed_up) = sync_into(&dst, true, 200).unwrap();
        assert!(!skipped);
        assert!(updated.contains(&"start-session".to_string()));
        let saved = backed_up.iter().find(|b| b.name == "start-session").expect("preserved");
        assert_eq!(
            fs::read(Path::new(&saved.backup).join("SKILL.md")).unwrap(),
            b"NEWER, FROM INSTALL.SH"
        );
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn sync_bootstraps_a_pre_existing_edited_install_by_backing_it_up() {
        let dst = tmp("sync-bootstrap");
        // An install from before base tracking existed: no .ao-base/ at all, and the
        // skill carries an untracked local edit. With no history, "was this edited or
        // just stale?" is unknowable — so the sync backs it up (cheap) rather than
        // guess (potentially someone's work), then brings it to the bundle.
        let bundle = SKILLS.get_dir("start-session").unwrap();
        extract_into(bundle, &dst.join("start-session")).unwrap();
        fs::write(dst.join("start-session/SKILL.md"), b"PRE-EXISTING LOCAL EDIT").unwrap();
        assert!(!dst.join(BASE_DIR).exists());

        let (_, _, updated, backed_up) = sync_into(&dst, false, 100).unwrap();
        assert!(updated.contains(&"start-session".to_string()));
        let saved = backed_up.iter().find(|b| b.name == "start-session").expect("preserved");
        assert_eq!(
            fs::read(Path::new(&saved.backup).join("SKILL.md")).unwrap(),
            b"PRE-EXISTING LOCAL EDIT"
        );
        assert!(!dir_differs(bundle, &dst.join("start-session")));
        assert!(dst.join(BASE_DIR).join("start-session/SKILL.md").exists());
        let _ = fs::remove_dir_all(&dst);
    }
}
