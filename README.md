<div align="center">

<a href="https://t-mercier.github.io/ai-agents-orchestrator/"><img src="docs/media/banner.png" alt="AI Agents Orchestrator — mission control for your AI development sessions" width="820"></a>

# AI Agents Orchestrator

**Mission control for your AI development sessions — a tiny native dashboard (macOS & Linux) that brings order to the chaos.**

[![Live site](https://img.shields.io/badge/%F0%9F%8C%90%20Live%20site-visit-9b8cff?style=for-the-badge)](https://t-mercier.github.io/ai-agents-orchestrator/)

[![Version](https://img.shields.io/badge/version-0.4.0--alpha-9b8cff)](CHANGELOG.md)
[![CI](https://img.shields.io/github/actions/workflow/status/t-mercier/ai-agents-orchestrator/ci.yml?branch=master)](https://github.com/t-mercier/ai-agents-orchestrator/actions)
[![License: Source Available](https://img.shields.io/badge/license-Source%20Available-blue.svg)](LICENSE)
[![macOS](https://img.shields.io/badge/macOS-13+-000000?style=flat&logo=apple)](https://www.apple.com/macos/)
[![Linux](https://img.shields.io/badge/Linux-X11%20%26%20Wayland-000000?style=flat&logo=linux&logoColor=white)](https://www.kernel.org/)
[![Made with Claude Code](https://img.shields.io/badge/Made%20with-Claude%20Code-000000)](https://claude.com/claude-code)

</div>


> AI coding sessions don't last minutes anymore. They last **days, weeks, sometimes entire projects** — each accumulating context, decisions, repositories, tasks and agents. Before long, you're juggling dozens of parallel workstreams.
>
> **AI Agents Orchestrator gives you a unified view of every session, across every project** — so you can stay focused instead of getting lost in the chaos.

## Contents

[What's new](#whats-new) · [The problem](#the-problem) · [Features](#features) · [How it works](#how-it-works) · [Quick start](#quick-start) · [Session skills](#session-skills) · [Customization](#customization) · [FAQ](#faq) · [Security](#security) · [Tech stack](#tech-stack) · [Roadmap](#roadmap) · [Changelog](#changelog) · [Contributing](#contributing) · [License](#license)


> [!NOTE]
> ## What's new
> Newest first — full history in the [changelog](CHANGELOG.md).
>
> - 🔗 **Several PRs / tickets per session** — a task split across two PRs, or an epic plus its sub-task, no longer has to pick one. The icon shows a count and opens a picker; the editor takes one entry per line and works on any session, not just REVIEW.
> - 📌 **Pinned sessions sit at the top of the column** — they used to float per space (and before that, per category), which defeated the point. One block at the top, just under ⚡ Needs you.
> - 🧹 **Cards view removed** — it overlapped the Board without being as useful, so the app is List + Board. Card density stays, applied to the list cards.
> - 📥 **"Recent · unmanaged" section + Adopt** — a lazy, collapsible section at the top of Running lists recent Claude Code sessions that aren't managed yet; one **Adopt** click resumes + registers them. (Replaces the old ＋Import button.)
> - 🗂 **Reorder & group your list (drag)** — in the List view, drag to reorder your categories and sessions, and **group related sessions** (e.g. sub-tickets of a parent) by dragging one onto another, Kanban-style. Collapsible, colour-coded, renamable groups.
> - 📊 **Usage bar → per-session** — the bar's **context %** and **model** now follow the **selected session** (the 5-hour & weekly windows stay account-global).
> - ⚙️ **Config v2, auto-migrated** — named **spaces**, each with its own Obsidian **vault**. A legacy v1 config (work/personal roots + category `scope`) is migrated to v2 on first launch, with a backup kept. Nothing to do by hand.
> - 📊 **Usage bar** — a slim bottom bar with your **model**, the **5-hour** & **weekly** rate-limit windows (with reset countdowns) and **context %**, right in the app. Automatic for sessions launched from the dashboard; never touches your global settings.
> - 🖥 **"Claude Desktop" group** — live sessions opened from the Claude Desktop app now group on their own instead of the catch-all "OTHER".
> - 📝 **Session summaries on cards** — cards & detail show the one-line summary written by `/save-session` · `/close-session`, not raw transcript output.
> - 🔒 **Security & robustness audit** — a Fable-assisted hardening pass across the Rust backend (pid clamp, `fsync`'d atomic writes, delete-guards, single-source validators).
> - 🧩 **Skills install themselves** — the app bundles the session skills and copies them into `~/.claude/skills/` on a click (a first-launch banner, or **Settings → Session skills**). A `.dmg`-only install no longer needs the repo + `install.sh`.
> - 🐧 **Linux support** — runs on X11 & Wayland (verified on GNOME/Wayland); `cargo tauri build` produces `.deb`/`.AppImage`. *(First external contributions — thanks [@FelixDombek-TomTom](https://github.com/FelixDombek-TomTom)!)*
> - 🔌 **Import, upgraded** — adopt a session into a chosen **space**, **paste a session ID** to grab one that isn't in the recent list, and open it in the **embedded** terminal or an external one.

## The problem

Today each session is a buried terminal tab. Which are running? Which are **waiting for you**? Which finished an hour ago? Where did you leave each one?

Terminal tabs don't scale. You need mission control.

## Features

- **Live dashboard** — polled every 5s. Every session's status at a glance: **busy** · **idle** · **waiting** (pulsing) · **stale** (terminal gone, work not wrapped up) · **background shell**.
- **Two views** — a grouped **List** and a **Board** (kanban).
- **Kanban board** — drag to reorder (insertion line), **drop a card onto another to group** them (named, collapsible), **attach notes** to a card or group, flag **urgent**, and add sessions from the board itself. Generative **column colours** (pick one seed → a harmonious set across however many columns you have), with each column tinting its own accent.
- **In-context detail** — click any card to open a **slide-over** with the session's goal, last activity, branch, Jira / PR links, and one-click **Resume / Restart / terminal** — without leaving the view.
- **Tickets & PRs on the card** — the ticket id and a GitHub icon sit on every card, clickable straight through to your tracker. A session can carry **several** of each (a task split across two PRs, an epic plus its sub-task): the icon then shows a count and opens a picker. Editable from the app, and `/save-session` · `/close-session` keep the lists filled as the work grows.
- **Start & resume your way** — open a **new** session or pick an existing one back up in the **built-in terminal** (in the app, xterm.js + portable-pty) *or* in **your own terminal** (iTerm / Terminal) — your choice, one toggle. Detach the built-in one into its own always-on-top window if you like.
- **Keyboard-first** — arrows / `j` `k` to navigate, `Enter` to launch, `/` to search, `1`–`3` for tabs, `←/→` to switch tabs, `v` to toggle list ⇄ board, `b` for board. **Remap any of it** in Settings → Shortcuts.
- **Looks & density** — curated colour "looks" (accent + a subtle surface ambiance), a custom accent, and Detailed / Compact / Minimal card density. Dark & light themes.
- **Lifecycle tabs** — Running · Closed · Archived, with live **search** and a **⚲ Filter** popover (category checkboxes, one control across every view).
- **Spaces** — group categories under multiple named spaces (e.g. *Work*, *Perso*, a client). The **List** organises into collapsible **space sections** → category groups; the **Board** gets its own space filter next to its search. Pinned and ⚡ waiting cards float above every space section — they're your shortlist, so they stay at the top of the column. A single space configured ⇒ no space chrome at all.
- **Backup** — export / import all your settings to a file (handy before a reinstall).

### Two ways to look at your work

| List | Board |
|:---:|:---:|
| ![List view](docs/media/hero.png) | ![Kanban board](docs/media/board.png) |
| Grouped by space → category, with the detail inline beside it. | Kanban with groups, attached notes, urgent flags, and generative column colours. |

On the Board, click any card for a **detail slide-over** — goal, branch, links, and one-click Resume / Restart — without leaving the board.

Make it yours — curated colour "looks" (accent + a subtle surface ambiance), a custom accent, density, dark **and** light themes:

| Appearance settings | A colour "look" — Rose Poudré |
|:---:|:---:|
| ![Appearance settings](docs/media/settings.png) | ![Rose Poudré look](docs/media/look-rose.png) |

…and the same dashboard in the light theme:

![Light theme](docs/media/light.png)

### Resume right in the app

![Embedded terminal resuming a Claude Code session in place](docs/media/terminal.png)

Every session resumes in an **embedded terminal** (xterm.js + a Rust pty) — pick the exact conversation back up where you left it, or pop it into its own always-on-top window.

## How it works

**Local-first. Zero network.**

AI Agents Orchestrator is a *projection* of the session state Claude Code already writes under `~/.claude` (session metadata, `notes.md`, JSONL transcripts). It **never** touches the network and **never** stores secrets — it visualizes what's on disk and lets Claude Code do the rest.

It is **read-only on your session data by design**. The only writes it makes to session files are explicit actions you trigger — **archiving** a session and **saving its PR links / tickets** — written atomically and confined to a `notes.md` under your configured roots (see [`docs/adr`](docs/adr)). Separately, you can ask it to **install the session skills** into `~/.claude/skills/` (a Settings button / first-launch prompt) — a user-triggered write confined to that skills folder, never touching your transcripts. Your UI preferences live in `localStorage` + your own config file.

## Quick start

**Requirements:** [Rust](https://rustup.rs) + the Tauri CLI (`cargo install tauri-cli`) · [Claude Code](https://claude.com/claude-code), plus your platform's WebView toolchain:

- **macOS 13+** — Xcode Command Line Tools (`xcode-select --install`).
- **Linux** — WebKitGTK + GTK dev libraries. On Debian/Ubuntu:
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev build-essential \
    curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
  ```

```bash
git clone https://github.com/t-mercier/ai-agents-orchestrator.git
cd ai-agents-orchestrator

# 1. Install the session skills + seed your config
bash scripts/install.sh

# 2. Run the app (system WebView — no Chromium bundled)
cargo tauri dev
```

The dashboard auto-discovers your sessions from `~/.claude`.

**Build an installable bundle:**

```bash
cargo tauri build      # macOS: .app/.dmg · Linux: .deb/.AppImage — in src-tauri/target/release/bundle/
```

> [!NOTE]
> **macOS:** built unsigned for now, so Gatekeeper flags it as "damaged" (it isn't). On recent macOS, right-click → **Open** no longer clears this — after moving the app to `/Applications`, strip the quarantine flag once from Terminal:
> ```bash
> xattr -cr "/Applications/AI Agents Orchestrator.app"
> ```
> Then open it normally. Signed/notarized releases come once it's out of alpha.

> [!NOTE]
> **Linux:** runs on X11 and Wayland (verified on GNOME/Wayland). One feature is macOS-only: *revealing* an existing external terminal window (there's no portable way to focus a window by tty on X11/Wayland), so that button is hidden on Linux. Opening a new terminal and the in-app embedded terminal both work.

## Session skills

The launcher buttons (**＋ New**, **Resume**, **Restart**, **Archive**) drive a small set of Claude Code skills. `scripts/install.sh` copies them into `~/.claude/skills/`:

| Skill | What it does |
|---|---|
| `/start-session <CAT> <ticket> <name>` | Create a session workspace + `notes.md` under the category's folder, register it, sync the repo |
| `/close-session` | Wrap up the session: summarise into `notes.md` + append a history entry tagged with the session id |
| `/save-session` | Checkpoint mid-flight (same summary as close, marked `(in progress)`) **without** closing it — handy before a context compaction |
| `/restart-session <slug>` | Reload a session's notes **and its recorded session id** into a fresh session (history stays linked) |
| `/archive-session <slug>` | Mark a session archived (drops it from the active list) |
| `/rename-category <OLD> <NEW>` | Rename a category everywhere — moves the folder, re-tags notes, updates config |

Categories, note locations and Obsidian vaults all come from your shared config, so the skills and the app stay in sync. The installer won't overwrite a customised skill unless you pass `--force`.

> [!IMPORTANT]
> **Updating from an earlier version?** Your config **auto-migrates to v2** on first launch — named spaces + per-space Obsidian vaults, with a `.v1-backup` kept (see [ADR-015](docs/adr/ADR-015-config-v1-to-v2-migration-flag-gated-self-cleaning.md)). Nothing to do by hand. **Re-run the installer to pull the updated skills:**
> ```bash
> bash scripts/install.sh --force
> ```

### Memory that beats compaction

Long sessions force the assistant to **compact** its own history — silently dropping older context until it loses the thread. This app keeps what matters in `notes.md` on disk instead: `/close-session` records the goal, decisions and next steps **plus the session id**; `/restart-session` loads all of it — and that id — into a fresh conversation, so the chain back to the original is never broken. Need the literal transcript? `claude --resume <id>` replays it verbatim.

```mermaid
flowchart LR
    S1(["Session 1<br/>you + Claude"]) -->|/close-session| N["notes.md<br/>goal · decisions · next steps<br/>+ session id"]
    N -->|"/restart-session &lt;slug&gt;"| S2(["Session 2<br/>fresh chat,<br/>briefed from the notes"])
    N -->|"claude --resume &lt;id&gt;"| R(["The exact original<br/>transcript, replayed"])
    S2 -->|/close-session| N
    classDef disk fill:#1e2230,stroke:#9b8cff,stroke-width:2px,color:#fff;
    class N disk;
```

Everything stays linked — **notes → session id → transcript** — so nothing important lives only in a context window.

<details>
<summary><strong>Optional: get nudged to <code>/save-session</code> before compaction</strong></summary>

A checkpoint only helps if you remember to run it. This **opt-in** Claude Code hook watches
the transcript size and reminds you to `/save-session` as context fills (≈50% / 75% / 90%).
It's not installed for you — the app never edits your global `~/.claude/settings.json`.
Add it there yourself under `hooks`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "SESSION_ID=$(jq -r '.session_id // empty' 2>/dev/null); [ -z \"$SESSION_ID\" ] && exit 0; T=$(find \"$HOME/.claude/projects\" -maxdepth 2 -name \"${SESSION_ID}.jsonl\" 2>/dev/null | head -1); [ -f \"$T\" ] || exit 0; S=$(wc -c < \"$T\"); if [ \"$S\" -gt 10000000 ] && [ ! -f \"/tmp/cc-90-$SESSION_ID\" ]; then touch /tmp/cc-50-$SESSION_ID /tmp/cc-75-$SESSION_ID /tmp/cc-90-$SESSION_ID; echo '{\"systemMessage\":\"Context ~90% - compact imminent. Run /save-session now.\"}'; elif [ \"$S\" -gt 6000000 ] && [ ! -f \"/tmp/cc-75-$SESSION_ID\" ]; then touch /tmp/cc-50-$SESSION_ID /tmp/cc-75-$SESSION_ID; echo '{\"systemMessage\":\"Context ~75% used. Run /save-session.\"}'; elif [ \"$S\" -gt 3000000 ] && [ ! -f \"/tmp/cc-50-$SESSION_ID\" ]; then touch /tmp/cc-50-$SESSION_ID; echo '{\"systemMessage\":\"Context ~50% used - consider /save-session.\"}'; fi" }] }]
  }
}
```

The `/tmp` flags make each threshold fire once per session. Pair it with a `PreCompact`
hook if you want a last-ditch save right before Claude Code compacts.

</details>

<details>
<summary><strong>Usage bar (model · 5h / weekly limits · context) — automatic</strong></summary>

A slim bottom bar shows your **model**, the **5-hour** and **weekly** rate-limit windows
(colour-coded, with reset countdowns), and the current **context %** — the numbers a Claude
Code statusline shows. Claude Code only hands that data to a `statusLine` command (never to
disk), so the app supplies its own.

**No setup needed** for sessions **launched from the dashboard**: the app installs a bundled
wrapper (`~/.claude/ao-statusline.sh`) and, at each launch, passes it as that session's
`statusLine` via `claude --settings` — **per-session, so it never edits your global
`settings.json`**. The wrapper writes `~/.claude/statusline-cache.json` (which the app reads
**read-only**) and then delegates to your own statusline, so your terminal statusline is
unchanged. See [`scripts/ao-statusline.sh`](scripts/ao-statusline.sh).

Caveat: only sessions started from the app feed the bar (the injection is per-launch), so it
dims as *stale* if you've only worked outside the app, and hides entirely when no cache exists.

</details>

📖 **New to the lifecycle?** The **[Guide](docs/GUIDE.md)** explains the four session states (Active · Stale · Closed · Archived), Start vs Resume vs Restart, and how the notes beat compaction — in plain terms, no jargon.

## Customization

Edit everything in the app's **Settings (⚙)** — categories & colours, scan roots, terminal app, themes/looks, density, keyboard shortcuts. It all persists to `~/.config/ai-agents-orchestrator/config.json` (which the skills read too):

```json
{
  "roots": [
    { "name": "Work",  "path": "~/work", "vaultPath": "~/work/vault" },
    { "name": "Perso", "path": "~", "vaultPath": "" }
  ],
  "categories": [
    { "name": "FEAT",   "color": "#7df0c0", "root": "Work" },
    { "name": "BUG",    "color": "#ff9eb1", "root": "Work" },
    { "name": "REVIEW", "color": "#d9a86e", "root": "Work" },
    { "name": "PERSO",  "color": "#8fd9ff", "root": "Perso" }
  ],
  "obsidian": { "enabled": false },
  "ticketBaseUrl": ""
}
```

Each category names the **space** it lives under — the `root` key in the config (its folder is `<space path>/<CATEGORY>`), so the *same* category name can exist in several spaces, and the titlebar space selector scopes the view. Each space can carry a `vaultPath` (its Obsidian vault). *(Back-compat: a legacy v1 config — `workRoot`/`personalRoot`, a category `scope` of `work`/`personal`, and `obsidian.workVaultPath`/`personalVaultPath` — is auto-migrated on launch to the `Work`/`Perso` spaces + per-space `vaultPath` (a backup is kept), so existing configs keep working untouched.)*

**Ticket tracking — any tracker, not just Jira.** `ticketBaseUrl` is just a URL prefix: the app appends each session's ticket ID to it to make the ID clickable. Point it at whatever you use:

| Tracker | `ticketBaseUrl` |
|---|---|
| Jira | `https://yourcompany.atlassian.net/browse/` |
| Linear | `https://linear.app/your-team/issue/` |
| GitHub Issues | `https://github.com/owner/repo/issues/` |
| Azure DevOps | `https://dev.azure.com/org/project/_workitems/edit/` |

Leave it blank and ticket IDs simply show as a (non-clickable) tag. *(The legacy key `jiraBaseUrl` is still read for backward compatibility.)*

## FAQ

**Does it show all my sessions, or only ones started with `/start-session`?** Two sources, both automatic:

- **Running** — *every live Claude Code session* on your machine shows up, managed or not. Unmanaged ones just carry less metadata (no goal/category/ticket) until you `/start-session` or `/restart-session` them.
- **Closed / Archived / Stale** — these list **managed** sessions: ones with a `notes.md` under your category roots (created by `/start-session`). That `notes.md` is what gives the dashboard the goal, history, and lifecycle state.

**Can I import my existing / older Claude sessions?** Live ones need nothing — they're already in **Running**. Past sessions that were never `/start-session`-ed have no `notes.md`, so they don't show in the historical tabs. To bring one under management, run `/restart-session <slug>` (or `/start-session`) for that work — it creates the `notes.md` and registers it. Setting your category **root dir** only tells the app *where* to scan for managed sessions; it doesn't ingest arbitrary `~/.claude` transcripts on its own.

> [!TIP]
> Auto-importing *any* past session (not just managed ones) isn't built yet — it's a great idea on the roadmap. Open an issue if you want it.

## Security

- **No shell-string execution** — `open`, `osascript`, `git`, `claude` are all spawned with separate args (no injection); AppleScript uses the `on run argv` pattern.
- Repo / branch / URL inputs are **allowlist-validated** (absolute path, real git repo, safe branch, `github.com/owner/repo/pull/N`).
- The session-file writes (archive, PR links, tickets) are **atomic**, target a real `notes.md`, and are **confined under your configured roots** (canonicalized — no `../` escape).
- **Installing the session skills** (optional, user-triggered) writes only under `~/.claude/skills/` — it copies the app's bundled skills there; it never touches session transcripts.
- External links open in your **system browser**, never inside the app.
- Nothing is sent over the network; no secrets stored.

## Tech stack

| Layer | Tool |
|---|---|
| Desktop | **Tauri v2** (Rust + the OS's WebView — ~8 MB app, no Chromium) |
| UI | Vanilla JS — no framework (fast, simple, hackable) |
| Terminal | xterm.js + portable-pty |
| Backend | Rust (`config` · `reader` · `pty` · commands) |
| Tests | Rust unit tests (73, `cargo test`) + Jest (65, renderer logic) — 138 total |

## Roadmap

- [x] In-app Settings UI (categories, colours, roots, themes, shortcuts)
- [x] Bundled session skills + one-command installer
- [x] Kanban board (groups, attached notes, generative colours)
- [x] Export / import settings
- [x] Tracker-agnostic ticket links (Jira, Linear, GitHub Issues, Azure DevOps)
- [ ] **Beyond Claude Code** — GitHub Copilot, and other agent CLIs next (today it reads Claude Code's session state)
- [ ] Standalone terminal tab — use the in-app terminal for ad-hoc commands, not just resuming a session
- [ ] Signed + notarized `.dmg` releases
- [ ] Homebrew cask · auto-update
- [ ] Optional Obsidian integration (auto-distil notes)

## Changelog

See [`CHANGELOG.md`](CHANGELOG.md) for notable changes ([Keep a Changelog](https://keepachangelog.com/) format).

## Contributing

**Issues and suggestions are very welcome** — bug reports, feature ideas, rough edges. This is an opinionated, design-led project that I maintain solo, so I keep tight control over the UX. I do occasionally accept well-scoped PRs — especially infrastructure and cross-platform work (Linux support [landed that way](CHANGELOG.md)) — but **please open an issue first** so we can agree on the approach before you write code. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

**[AI Agents Orchestrator Source Available License v1.0](LICENSE)** — free to download, use, and evaluate, including in the course of your professional work at a company. You **may not** resell it, redistribute it, deploy it organization-wide, offer it as a hosted/SaaS service, rebrand it, or distribute modified versions, without written permission. Source is available for transparency, learning, and contribution. Want to do more? Reach out.

Built by an ADHD developer who loves parallel-tasking with Claude a little too much — for anyone juggling more parallel work than one brain can hold.
