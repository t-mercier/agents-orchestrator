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

/// Where the 3-way base snapshots live — one pristine copy of each skill, as it stood
/// the last time an installer *adopted* a bundle for it. Sibling of `.archive/` (already
/// under `~/.claude/skills/`, already excluded from every `*/SKILL.md` glob and from the
/// bundle's own directory iteration, since neither name is a skill this bundle carries).
const BASE_DIR: &str = ".ao-base";

/// How a skill's on-disk copy relates to its last known base and to this bundle.
/// `LocalOnly` and `Conflict` never trigger a write — the whole point of tracking a base
/// per skill is telling "a `/skill-propose` patch survived an app update" from "this
/// skill is just stale", which a single date or a single differs-or-not bit cannot.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum SkillClass {
    /// Base, bundle and disk already agree (or would, once a missing base is seeded) —
    /// nothing to do.
    UpToDate,
    /// Only the bundle moved since the base was last confirmed. Safe to adopt.
    UpstreamOnly,
    /// Only the on-disk copy moved since the base was last confirmed — a `/skill-propose`
    /// patch or a hand edit. Never touched.
    LocalOnly,
    /// Both moved since the base was last confirmed (including: no base exists yet AND
    /// disk already differs from the bundle — which side moved first is unknowable).
    /// Never touched; surfaced by name so a human can decide.
    Conflict,
}

/// Classify `target` against `bundle_dir` using the pristine snapshot at `base` (if any).
/// Pure — no I/O beyond reading the three trees; never writes.
fn classify_skill(bundle_dir: &Dir, base: &Path, target: &Path) -> SkillClass {
    if !base.exists() {
        // No base yet (a pre-existing install, from before this feature, or a skill that
        // has never been through an installer that stamps one). We only know one bit:
        // does the bundle already match what's on disk? If so there is nothing to lose
        // by treating this as up to date and starting to track it. If not, we genuinely
        // cannot tell whether the bundle moved, the disk moved, or both — call it a
        // conflict rather than guess, same as if both had moved with a real base.
        return if dir_differs(bundle_dir, target) { SkillClass::Conflict } else { SkillClass::UpToDate };
    }
    let bundle_moved = dir_differs(bundle_dir, base);
    let disk_moved = paths_differ(base, target);
    match (bundle_moved, disk_moved) {
        (false, false) => SkillClass::UpToDate,
        (true, false) => SkillClass::UpstreamOnly,
        (false, true) => SkillClass::LocalOnly,
        (true, true) => SkillClass::Conflict,
    }
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
/// previous (or absent) base, which only makes the next classification MORE cautious.
fn refresh_base(bundle_dir: &Dir, base: &Path) {
    let _ = fs::remove_dir_all(base);
    let _ = extract_into(bundle_dir, base);
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
    /// Present skills only the bundle moved on since the last confirmed base — safe for
    /// `update_skills()` to adopt automatically.
    pub upstream_only: Vec<String>,
    /// Present skills only the on-disk copy moved on since the last confirmed base — a
    /// `/skill-propose` patch or a hand edit. `update_skills()` never touches these.
    pub local_only: Vec<String>,
    /// Present skills where BOTH sides moved since the last confirmed base (or where no
    /// base exists yet and the bundle already differs, so which side moved first is
    /// unknowable). `update_skills()` never touches these either; named so a human can
    /// resolve them, e.g. via the explicit force-overwrite path.
    pub conflicts: Vec<String>,
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
    let base_root = dst.join(BASE_DIR);
    let mut present = Vec::new();
    let mut missing = Vec::new();
    let mut differs = Vec::new();
    let mut upstream_only = Vec::new();
    let mut local_only = Vec::new();
    let mut conflicts = Vec::new();
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
        match classify_skill(d, &base_root.join(&name), &target) {
            SkillClass::UpToDate => {}
            SkillClass::UpstreamOnly => upstream_only.push(name.clone()),
            SkillClass::LocalOnly => local_only.push(name.clone()),
            SkillClass::Conflict => conflicts.push(name.clone()),
        }
        present.push(name);
    }
    present.sort();
    missing.sort();
    differs.sort();
    upstream_only.sort();
    local_only.sort();
    conflicts.sort();
    SkillsStatus {
        installed: missing.is_empty(),
        present,
        missing,
        differs,
        bundle_epoch: bundle_epoch(),
        installed_epoch: read_installed_epoch(&dst),
        upstream_only,
        local_only,
        conflicts,
    }
}

/// Report from `update_skills()` — the smart, base-aware counterpart to `install_skills`.
#[derive(Serialize)]
pub struct UpdateReport {
    /// Skills that were missing entirely, installed fresh (always includes `lib`).
    pub installed: Vec<String>,
    /// Present skills adopted from the bundle because only it had moved since the last
    /// confirmed base.
    pub updated: Vec<String>,
    /// Present skills left untouched because only the on-disk copy had moved — a
    /// `/skill-propose` patch, or a hand edit, survives.
    pub kept_local: Vec<String>,
    /// Present skills where both sides moved (or no base exists and they already
    /// differ): left untouched, named so a human can resolve them.
    pub conflicts: Vec<String>,
    pub config_seeded: bool,
    pub dirs_created: Vec<String>,
}

/// Update `dst`'s skills against the bundle without ever discarding a local change:
/// - missing skills are installed fresh, same as `install_into`;
/// - a skill only the bundle moved on is adopted, and its base refreshed;
/// - a skill only the disk moved on (or where neither side is resolvable — no base yet
///   and it already differs) is left exactly as it is.
///
/// `lib/` is always refreshed regardless — it is app-owned, never a target for
/// `/skill-propose`, and was never given base tracking to begin with.
///
/// Pure I/O on `dst`, unit-testable against a temp dir, same shape as `install_into`.
fn update_into(
    dst: &Path,
) -> std::io::Result<(Vec<String>, Vec<String>, Vec<String>, Vec<String>)> {
    let mut installed = Vec::new();
    let mut updated = Vec::new();
    let mut kept_local = Vec::new();
    let mut conflicts = Vec::new();
    let base_root = dst.join(BASE_DIR);
    fs::create_dir_all(dst)?;
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
        match classify_skill(d, &base, &target) {
            SkillClass::UpToDate => {
                // Bootstrap: no base yet, but content already matches — start tracking
                // from here without touching the (already-correct) skill itself.
                if !base.exists() {
                    refresh_base(d, &base);
                }
            }
            SkillClass::UpstreamOnly => {
                fs::remove_dir_all(&target)?;
                extract_into(d, &target)?;
                refresh_base(d, &base);
                updated.push(name);
            }
            SkillClass::LocalOnly => {
                kept_local.push(name);
            }
            SkillClass::Conflict => {
                // Bootstrap-conflict (no base, already differs): start tracking from
                // THIS bundle going forward, without touching or judging what's on disk
                // now. A real conflict (base existed, both sides moved): leave the base
                // as-is too — refreshing it here would silently resolve the conflict in
                // the bundle's favour on the next check, which is exactly the silent
                // loss this whole mechanism exists to prevent.
                if !base.exists() {
                    refresh_base(d, &base);
                }
                conflicts.push(name);
            }
        }
    }
    installed.sort();
    updated.sort();
    kept_local.sort();
    conflicts.sort();
    Ok((installed, updated, kept_local, conflicts))
}

/// The safe counterpart to `install_skills(force)`: adopts bundle changes only where
/// nothing local would be lost, seeds config/category folders same as `install_skills`,
/// and stamps the epoch manifest only when the tree now fully matches the bundle (no
/// `kept_local`, no `conflicts` left standing) — the same "never claim a match that
/// isn't there" rule `install_into` already follows.
#[tauri::command]
pub fn update_skills() -> Result<UpdateReport, String> {
    let dst = config::home().join(".claude").join("skills");
    let (installed, updated, kept_local, conflicts) = update_into(&dst).map_err(|e| e.to_string())?;
    let config_seeded = config::seed_default_if_absent()?;
    let mut dirs_created = Vec::new();
    for base in config::category_base_dirs() {
        if !base.exists() && fs::create_dir_all(&base).is_ok() {
            dirs_created.push(base.to_string_lossy().into_owned());
        }
    }
    if kept_local.is_empty() && conflicts.is_empty() {
        write_installed_epoch(&dst, bundle_epoch());
    }
    Ok(UpdateReport { installed, updated, kept_local, conflicts, config_seeded, dirs_created })
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

    // ── 3-way classification (classify_skill / paths_differ) ──

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

    #[test]
    fn classify_skill_matrix() {
        let dst = tmp("classify");
        let bundle = SKILLS.get_dir("start-session").expect("bundled start-session");
        let base = dst.join("base");
        let target = dst.join("target");

        // No base yet, disk already matches the bundle → up to date (silent bootstrap).
        extract_into(bundle, &target).unwrap();
        assert_eq!(classify_skill(bundle, &base, &target), SkillClass::UpToDate);

        // No base yet, disk already differs → conflict (unknowable which side moved).
        fs::write(target.join("SKILL.md"), b"EDITED BEFORE ANY BASE").unwrap();
        assert_eq!(classify_skill(bundle, &base, &target), SkillClass::Conflict);

        // A base exists and everything agrees → up to date.
        extract_into(bundle, &base).unwrap();
        extract_into(bundle, &target).unwrap();
        assert_eq!(classify_skill(bundle, &base, &target), SkillClass::UpToDate);

        // Only disk moved since the base → local-only (a /skill-propose patch).
        fs::write(target.join("SKILL.md"), b"LOCAL PATCH").unwrap();
        assert_eq!(classify_skill(bundle, &base, &target), SkillClass::LocalOnly);

        // Simulate upstream moving on: base and disk still agree with EACH OTHER at some
        // older shared point (disk never independently diverged from base) — but the
        // real bundle (fixed, embedded) has moved past that point → upstream-only.
        fs::write(base.join("SKILL.md"), b"OLDER SHARED POINT").unwrap();
        fs::write(target.join("SKILL.md"), b"OLDER SHARED POINT").unwrap();
        assert_eq!(classify_skill(bundle, &base, &target), SkillClass::UpstreamOnly);

        // Both the base-vs-bundle gap AND a disk edit on top → conflict.
        fs::write(target.join("SKILL.md"), b"LOCAL PATCH ON TOP OF STALE BASE").unwrap();
        assert_eq!(classify_skill(bundle, &base, &target), SkillClass::Conflict);

        let _ = fs::remove_dir_all(&dst);
    }

    // ── update_into: the base-aware update ──

    #[test]
    fn update_installs_missing_skills_fresh_and_seeds_their_base() {
        let dst = tmp("update-fresh");
        let (installed, updated, kept_local, conflicts) = update_into(&dst).unwrap();
        assert!(installed.contains(&"lib".to_string()));
        assert!(installed.contains(&"start-session".to_string()));
        assert!(updated.is_empty() && kept_local.is_empty() && conflicts.is_empty());
        assert!(dst.join(BASE_DIR).join("start-session/SKILL.md").exists());
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn update_adopts_upstream_only_changes() {
        let dst = tmp("update-upstream");
        update_into(&dst).unwrap(); // seeds base == bundle == disk for every skill
        // Simulate the bundle moving on: base and disk still agree with each other at
        // an older shared point, but the real (fixed, embedded) bundle has moved past it.
        fs::write(dst.join(BASE_DIR).join("start-session/SKILL.md"), b"OLDER").unwrap();
        fs::write(dst.join("start-session/SKILL.md"), b"OLDER").unwrap();
        let (_, updated, kept_local, conflicts) = update_into(&dst).unwrap();
        assert!(updated.contains(&"start-session".to_string()));
        assert!(kept_local.is_empty() && conflicts.is_empty());
        // The skill itself was adopted from the bundle, and the base refreshed to match.
        let bundle = SKILLS.get_dir("start-session").unwrap();
        assert!(!dir_differs(bundle, &dst.join("start-session")));
        assert!(!paths_differ(&dst.join(BASE_DIR).join("start-session"), &dst.join("start-session")));
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn update_never_touches_a_skill_propose_patch() {
        let dst = tmp("update-local");
        update_into(&dst).unwrap();
        // Simulate an approved /skill-propose patch: disk moves, base does not.
        fs::write(dst.join("start-session/SKILL.md"), b"MY OWN IMPROVEMENT").unwrap();
        let (_, updated, kept_local, conflicts) = update_into(&dst).unwrap();
        assert!(kept_local.contains(&"start-session".to_string()));
        assert!(updated.is_empty() && conflicts.is_empty());
        // Untouched, byte for byte — this is the whole point.
        assert_eq!(fs::read(dst.join("start-session/SKILL.md")).unwrap(), b"MY OWN IMPROVEMENT");
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn update_names_a_conflict_and_touches_nothing() {
        let dst = tmp("update-conflict");
        update_into(&dst).unwrap();
        // Both sides moved since the shared base.
        fs::write(dst.join(BASE_DIR).join("start-session/SKILL.md"), b"OLDER").unwrap();
        fs::write(dst.join("start-session/SKILL.md"), b"MY OWN IMPROVEMENT ON TOP").unwrap();
        let (_, updated, kept_local, conflicts) = update_into(&dst).unwrap();
        assert!(conflicts.contains(&"start-session".to_string()));
        assert!(updated.is_empty() && kept_local.is_empty());
        assert_eq!(
            fs::read(dst.join("start-session/SKILL.md")).unwrap(),
            b"MY OWN IMPROVEMENT ON TOP",
            "a conflict must never be silently resolved either way"
        );
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn update_bootstraps_a_pre_existing_install_without_erasing_it() {
        let dst = tmp("update-bootstrap");
        // Simulate an install from before this feature existed: no .ao-base/ at all,
        // and the skill already has a locally-patched, never-tracked copy.
        let bundle = SKILLS.get_dir("start-session").unwrap();
        extract_into(bundle, &dst.join("start-session")).unwrap();
        fs::write(dst.join("start-session/SKILL.md"), b"PRE-EXISTING LOCAL PATCH").unwrap();
        assert!(!dst.join(BASE_DIR).exists());

        let (_, updated, kept_local, conflicts) = update_into(&dst).unwrap();
        assert!(conflicts.contains(&"start-session".to_string()), "unknowable on first sight");
        assert!(updated.is_empty() && kept_local.is_empty());
        assert_eq!(
            fs::read(dst.join("start-session/SKILL.md")).unwrap(),
            b"PRE-EXISTING LOCAL PATCH",
            "bootstrap must never erase what was already there"
        );
        // But tracking now starts: a base was seeded from THIS bundle for next time.
        assert!(dst.join(BASE_DIR).join("start-session/SKILL.md").exists());
        let _ = fs::remove_dir_all(&dst);
    }
}
