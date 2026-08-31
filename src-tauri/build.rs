use std::process::Command;

fn main() {
  tauri_build::build();

  // The date of the bundled skills, for skills::skills_status()'s "would this overwrite
  // go backward?" check. Reads the last commit that actually touched skills/ (not HEAD)
  // so an unrelated later commit — a renderer change, a doc fix — doesn't make the app
  // think its bundle is newer than it really is. A missing `.git` (a tarball build) or a
  // failed lookup falls back to "0", which skills::bundle_epoch() reads as "unknown" and
  // the UI treats as neutral rather than as a false claim in either direction.
  let epoch = Command::new("git")
    .args(["log", "-1", "--format=%ct", "--", "skills"])
    .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/.."))
    .output()
    .ok()
    .filter(|o| o.status.success())
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "0".to_string());
  println!("cargo:rustc-env=AO_SKILLS_BUNDLE_EPOCH={epoch}");

  // Re-run when skills/ changes so a local `tauri dev` picks up the new date, not just
  // whatever was true the first time cargo built this crate.
  println!("cargo:rerun-if-changed=../skills");
}
