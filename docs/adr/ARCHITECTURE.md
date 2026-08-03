# Target Architecture

**Tauri v2 macOS & Linux app** (Rust backend + the system WebView — no Chromium bundled). Single-user, local-first, a read-only projection of `~/.claude`. The numbered ADRs in this folder trace the original Electron design and the Electron→Tauri migration; this file describes the current (Tauri) architecture.

Two subsystems:

1. **Backend — Rust (`src-tauri/src/`)**: `reader.rs` polls `~/.claude` (sessions/*.json + active-sessions.json + notes.md + jsonl transcripts) every 5s, classifies running / stale / closed / archived, and folds transcript-derived metadata (goal, last activity, branch, PR links) — all mtime/TTL-cached. `config.rs` loads/derives the shared config (`~/.config/ai-agents-orchestrator/config.json`). `pty.rs` runs one embedded terminal per session via `portable-pty`. `lib.rs` is the `#[tauri::command]` surface (session launch, terminal reveal, the two bounded writes, window detach, settings export/import).

2. **Renderer — vanilla JS (`renderer/`)**: `app.js` (view-state machine + polling + appearance), `ui.js` (list/detail templates + event delegation), `board.js` (kanban), `terminal.js` (xterm.js panes), `settings/` (per-tab files behind a registry), and pure UMD modules under `renderer/lib/` (board-model, formatters, markdown, categories — unit-tested). It talks to Rust through `lib/tauri-api.js`, a thin shim over Tauri `invoke` (so the renderer stays framework-free). Embedded-terminal output streams from Rust via the `pty-data` event into per-session xterm instances.

**Key invariants:**
- Running = alive pid in `~/.claude/sessions/*.json` (libc::kill(pid,0)); stale = open work whose terminal is gone; closed = a `/close` wrap-up line; archived = an ARCHIVED history line.
- **Read-only on `~/.claude`**, with two deliberate, bounded source-of-truth writes (ADR-013): archiving a session and setting a PR link. Both are atomic (tmp + rename), target a real `notes.md`, and are canonicalized + confined under a configured root.
- Command surface is small; every input is allowlist-validated (sessionId/category/branch regexes, absolute-path + git-repo checks, `github.com/owner/repo/pull/N`). Processes are spawned argv-only (no shell strings); AppleScript uses the `on run argv` pattern. No network, no secrets stored.
- One pty per sessionId; killed **and reaped** (`wait()`) on close/quit so no `<defunct>` zombies. xterm instance cached per session.
- Caches: transcript fold keyed by (len, mtime); git info per cwd with a short TTL; derived config by config.json mtime.
- UX: 5s polling with frozen sort (no reorder under the cursor); status badges (busy / waiting-pulse / idle / stale); two views (List / Board); keyboard-first with remappable shortcuts.

**Distribution:** `cargo tauri build` produces an unsigned ~8 MB `.app`/`.dmg` (macOS) or `.deb`/`.AppImage` (Linux). Signed + notarized releases (and a Tauri release workflow) come post-alpha.

**Not in scope yet:** signed releases / auto-update, Homebrew cask, MCP config UI, non-Claude-Code agents (Copilot et al.), multi-machine sync, Windows port.
