# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/).

> Add entries under **[Unreleased]** as you go; when you tag a release, rename that
> section to the version + date and start a fresh **[Unreleased]** above it.

## [Unreleased]

### Added
- **An opt-in hook nudges `/learn` the moment a preference or correction is typed** —
  `/learn` and `/skill-propose` already say "use PROACTIVELY" in their own description,
  but nothing forced the check at the actual turn it mattered, so the knowledge notes
  only grew when you asked for it by name. `hooks/learn_nudge.py` runs on
  `UserPromptSubmit`: it matches your message against a short, high-precision phrase list
  ("always", "never", "from now on", "je préfère", "ne ... plus"...) and, on a hit,
  injects a one-line reminder for the model to check `/learn`'s or `/skill-propose`'s own
  criteria — silently, so a message that doesn't actually qualify produces no visible
  output. Throttled to once per session per 15 minutes. Install with
  `bash scripts/install.sh --with-hooks`, same opt-in path as the PR-attach hook; wiring
  into `settings.json` is printed, never written for you. 14 tests.

### Fixed
- **Resume stops shadowing itself when the frontmatter session_id is dead** — the
  effective resumable id fell back to the newest registered id only when the
  frontmatter's own `session_id` had the WRONG SHAPE (a `/start-session` stub
  placeholder). A well-formed but dead id — its transcript deleted, or the frontmatter
  hand-edited or copied from another session — satisfied that check and the fallback
  never ran, so a ticket with several real, later conversations recorded against it
  could offer Restart and never Resume, permanently. The choice now checks whether the
  frontmatter id's conversation actually exists on disk, not just whether it looks like
  one.

## [0.9.0-alpha] - 2026-08-20

### Added
- **Sync realigns a session's tickets and PRs, instead of only refreshing PR states** — it
  discovered nothing: a pull request opened after the last checkpoint stayed invisible
  however often you pressed the button, and ticket statuses were never touched, so a board
  showing `Triaged` for something long since `Done` had no way back. The name promised more
  than the button did.

  It now runs two passes. First the new **`/sync-refs`** headless: the agent reads each
  ticket's current status through the tracker MCP, asks `gh` for the pull requests whose
  branch names one of the session's tickets, and rewrites the frontmatter. Then the
  existing `gh` pass for each PR's state and title.

  The app gains no credentials from this. Reading a tracker needs an account, and an agent
  already has one through MCP — which is also why the pass costs a few tokens and some
  seconds rather than being instant. There is no `--resume`: this needs the session's
  frontmatter, not its conversation.

  Statuses are **replaced** — a status is a snapshot, and a stale one presented as current
  is the entire problem being fixed. PR links are only ever **added**: a link attached by
  hand is a deliberate act, and pruning belongs to the editor.

## [0.8.3-alpha] - 2026-08-14

### Changed
- **A session opens at the root of its space — one rule, every session** — the working
  directory used to come from wherever `claude` happened to be started the first time,
  which made it a property of history rather than of configuration: move a space in
  Settings and its older sessions kept opening at the old place, with nothing in the UI
  able to correct it. It is now resolved from the space the session belongs to, on both
  launch paths and from every tab. A session outside every configured space — an unmanaged
  one — keeps the directory it recorded, since that is the only thing known about it.

  This also replaces the launch-time narrowing shipped in 0.8.1 and 0.8.2, which moved a
  session into its own notes folder. That cut sessions off from the repositories sitting
  beside their notes, which is usually the reason the space root is the useful answer.

## [0.8.2-alpha] - 2026-08-14

### Fixed
- **The working directory rule reached the historical tabs** — 0.8.1 applied it to running
  sessions only, so a resume from Closed or Archived still used the older behaviour. Both
  read paths were brought in line.

## [0.8.1-alpha] - 2026-08-13

### Changed
- **First pass at deciding a session's working directory from configuration** — it had
  been taken from wherever `claude` was first started, recorded in the transcript. This
  release moved it towards the session's own folder; 0.8.3 settled on the space root,
  which is the rule that shipped.

## [0.8.0-alpha] - 2026-08-13

### Added
- **A pull request tells you whether it is open, merged or closed** — the cards carried a
  link to each PR and nothing about its state, so the one question you actually have (is
  this still waiting on me?) meant opening GitHub. The GitHub mark is now tinted by state
  in the list and on the board, and the detail panel spells each PR out as a labelled chip
  with its title: `#5107 test: assert the route-instruction source holds no features`.
  Colour never carries the meaning alone — every state also has a mark, both for
  colour-blind readers and because green / orange / red are already the session status dot
  a few pixels away on the same card.
- **Sync is a button, and the only thing here that touches the network** — no timer, and no
  Settings toggle either, since the button *is* the opt-in. The promise becomes "zero
  network until you press Sync", which is one honest asterisk rather than a preference
  someone can forget having enabled. State comes from `gh` with your existing login,
  cached in `~/.config/ai-agents-orchestrator/pr-status.json` — never in `notes.md`, whose
  frontmatter belongs to you and the session skills. A PR never synced reads *not synced*,
  not blank: blank would say "no PR here".
- **A ticket shows its tracker's own status word** — `In Review`, `Triaged`, whatever your
  project calls it, since folding those into three words of ours would lose the
  distinction the project actually works with. Only the *colour* is folded, into the same
  families as a PR: one grammar for both — moving, finished, abandoned, in draft, nothing
  yet. The status comes from a `ticket_states:` frontmatter list written by the session
  skills, so the app holds no tracker credentials. It shows on the icon, in the picker,
  and as a chip per ticket in the detail panel, beside the PRs.
- **Close wraps a stale session up for real, without opening a terminal** — it used to
  stamp a marker and nothing else, landing the session in Closed with no summary and no PR
  attached. It now resumes the session headless and lets the new `/wrap-session` write the
  actual wrap-up. That skill is `/close-session` steps 1–6 and nothing else: no distil, no
  skill proposal, no questions, since `--print` has no one to answer them. The close marker
  is what *means* Closed, so the app verifies the file rather than the exit code and stamps
  the plain marker itself on failure or timeout — a session you asked to close never stays
  stale.

### Changed
- **Restart only appears when Resume cannot** — where Resume works it is strictly better,
  and a compaction already resets the context, so two buttons only made the choice harder.
  Restart survives for sessions whose transcript is gone, where rebuilding from the notes
  is the sole option.
- **One door per action in the detail panel** — the standing Edit button is gone: both
  pickers already end in "Add / edit…", so it was a second way into one dialog. It
  survives only when neither picker exists, which is exactly when you need it to attach a
  first PR or ticket. The ticket and PR icons now always open their picker, single link
  included, which is what makes dropping Edit safe.
- **"End session" is "Close session"** — the rest of the lifecycle already said Closed
  everywhere; only the terminal's own button said End, which read as a fourth state.
- **One look-card grid for Appearance, Categories and Board columns** — board colours drew
  flat colour blocks while the other two drew a tinted card with the accent as an inner
  dot, which is why that panel read as belonging to a different app. The block had been
  copy-pasted three times and the copies had drifted; it is now one shared renderer, and
  the round colour dot one rule instead of two sizes.
- **Reference links tint on hover instead of underlining** — these rows are dense and full
  of monospaced ids, where an underline crowds the descenders and reads as noise.

- **`/skill-propose` fires in flight, and counts rewrite passes** — its criteria already
  covered "the user corrected your approach", but the skill was reachable only from the
  session close, so the strongest signal available went unnoticed while it was happening.
  Measured on a real session: three rewrite passes of the same review comments, both
  rejections traceable to gaps in the writing skill, and no proposal until the user asked
  for one. It is now proactive, and a *second* rewrite pass of one output is a criterion in
  its own right — a first attempt that followed the instructions and was still wrong means
  the instructions are what is missing. A new step locates the defect: when the corrected
  output came from a skill, that skill is the first suspect and the proposal is a patch to
  it, quoting the passage that led into the mistake.
- **The knowledge notes follow one schema, written by one skill** — `/close-session` wrote a
  whole session into `<vault>/sessions/<slug>.md`: no id, no frontmatter, no index row, so
  the search could not rank it and nothing linked to it — a fifth copy of `notes.md` rather
  than a distil. It now goes through `/learn` (one note per decision worth keeping,
  `origin: close-session`), which is the single writer that knows the vault's layout and
  extends an existing note instead of adding a near-duplicate. Promoted bullets are marked
  in `notes.md` so the next close does not promote them twice.
- **`/learn` honours the vault's own conventions** — a `README.md` or `CONVENTIONS.md` at the
  vault root is the user's contract, so it is read and followed, frontmatter keys included,
  before falling back to the built-in shape. That shape gains the keys a PARA +
  Zettelkasten vault carries and the template omitted: `projects:`, `mocs:`, and a
  `related:` filled from the notes read while searching — a note nothing points at is
  reachable only by full-text luck.
- **`/route` reads the index and the Maps of Content** — it searched the atomic notes and
  the areas while ignoring `INDEX.md` and `30-MOCs/`, so `/learn` maintained an index that
  nothing consumed. It now reads the index first (leaves before the tree is the wrong
  order, and it is where an orphan note becomes visible) and searches the MOCs alongside
  the notes. `route_search.py` gains a `mocs` mode; 16 selftests.

### Fixed
- **Saving the Edit-refs dialog no longer races itself** — it wrote tickets and PR links
  through `Promise.all`, and both commands read-modify-write the same `notes.md`. Two
  distinct failures came out of that: the temp file was derived from the target alone, so
  the second writer truncated the first one's temp and then renamed a path already moved
  away ("No such file or directory"); and both writers started from the same pre-edit
  content, so one edit was silently dropped. Temps now carry a pid and counter, and the
  two writes run in sequence.
- **One icon speaks only when the set agrees** — a session with three PRs showed a cross
  reading "closed" while two of them were still open, because the summary picked the most
  demanding state and presented it as the whole answer. Disagreement now shows no state at
  all; the picker is one click away for the detail.
- **The state marks are SVG, and drawn for the size they are shown at** — the pencil and
  the dotted ring were dingbats absent from SF Pro, so macOS substituted another face or
  drew nothing: draft and un-synced simply had no visible mark. They are also no longer
  24px icons shrunk to 11 with a heavy stroke, which read as smears.
- **The PR numbers line up** — the marks are not all the same width, so each row sized its
  own and the ids after it stepped left and right down the list.
- **Close is reachable from the Actions row, and the ticket / PR icons are back in it** —
  Close only ever existed as a hover icon on a list card, and the icons had been dropped
  from that row when the links moved into the Infos rows, which sit at the top of a pane
  you have usually scrolled past by then.
- **The Infos rows read as pairs** — the gap between two rows was the same as between a
  label and its own value, so nothing grouped.

### Documentation
- **The web page hands out builds directly** — it only ever linked to the repo, so someone
  who wanted the app had to find the releases page, then the right asset. Two download
  buttons now resolve the newest release's `.dmg` and `.AppImage` at load, with the `.deb`
  and `.rpm` beside them. Nothing is hardcoded: the asset names carry the version, and
  `releases/latest` is unusable while every release is a prerelease (the API 404s), so the
  markup links to the releases listing and a script upgrades it — offline or rate-limited,
  the static links still work. The Gatekeeper `xattr` line now sits next to the macOS
  button, where a direct downloader will actually meet it.
- **The knowledge tier leads the page instead of trailing it** — memory sat last, after
  security, so the one part that compounds over months read as a footnote. It now comes
  straight after the problem statement, covers `/learn` (a note written the moment
  something is learned, extending the note that already owns the subject rather than
  duplicating it), and adds the skills loop: `/skill-propose` stages, `/skills-review` is
  the only gate, `/skills-curate` archives and never deletes. The skill list on the page
  had drifted to the session lifecycle alone; the five knowledge skills are in it now.

## [0.7.0-alpha] - 2026-08-11

### Added
- **A PR opened mid-session attaches itself to the notes** — a session's PRs come from the `pr_link:` / `pr_links:` frontmatter, and only the session skills write those keys, so a PR opened while working stayed invisible until the next `/save-session`. An opt-in `PostToolUse` hook now reads the URL `gh` prints and appends it. Because it writes, two guards matter: the command must be a `create` (never `edit` or `list`, whose output is full of other people's PRs), and the URL must come from the tool's own response, so a `--body` referencing a dependency is not mistaken for the new PR. Writes are additive, idempotent and atomic; 19 tests. Install with `bash scripts/install.sh --with-hooks`, which copies the script and prints the `settings.json` entry to paste — the wiring is left to you, since that file decides which code runs.
- **`/learn` — the knowledge notes fill as you work** — the distil was bolted to `/close-session`, so it inherited a two-step dependency: the close writes `## Decisions made`, and only then can a distil promote it. Two manual gestures in series, and a session you never close teaches the next one nothing — which is why both vaults here had gone thirty days without a single note. `/learn` writes one atomic note **the moment** something durable comes up, straight into the space's knowledge notes, bypassing `notes.md` entirely. The bar is Hermes' (its `memory` tool description, which we read rather than guessed at): preferences and corrections first, then stable environment facts, then gotchas with their workaround — with the one-line test *does writing this stop the user repeating themselves?*, and an explicit skip-list (task progress, temporary state, anything cheaply re-discovered; a reusable procedure is a skill, not a note). It **extends an existing note rather than adding a near-duplicate** — reusing `route_search.py` to find one — and links every note into `INDEX.md`, since an orphan note is one nobody finds. There is deliberately **no approval prompt**: one at every insight would defeat writing in flight, so the safeguard is that every write is announced in one line and carries its origin session. The skill ships; the always-loaded trigger is a `~/.claude/CLAUDE.md` snippet documented in the README, the same opt-in shape as the `/save-session` Stop hook.

### Fixed
- **A session with no references offered no way to attach one** — the detail header carried only the ticket and PR icons, and those are hidden when nothing is attached, so the Edit button was out of reach in exactly the case where you needed it. Edit now sits in the header cluster too, and stays reachable while the embedded terminal is up.
- **The default launch model is `opus[1m]` again** — restored in `pty.rs` / `lib.rs` after an earlier change moved it to `opus`. *(Entry written from the commit; correct the reason if it differs.)*
- **Two Settings fields silently discarded what you typed** — Integrations still carried *Work vault path* and *Personal vault path* inputs left over from the v1 work/personal split. No JS ever read or collected them (their ids appeared nowhere else), so a folder typed there vanished on Save while the feature looked configured. They are gone, replaced by a line pointing at the real setting: the folder lives on each **space**, under *General → Spaces*.

### Documentation
- **`/route` is listed in the guide**, and `/import-session` in the README's skills table — both are bundled and were missing from one of the two lists. The README's *What's new* also picked up the 0.6.0 features it never mentioned (clickable terminal links, references in the detail panel, browsing every untracked session).

## [0.6.1-alpha] - 2026-08-10

### Fixed
- **The reference textareas look like every other modal field** — the Edit dialog's Tickets and Pull-requests boxes were added with no styling, so they rendered with the browser's default chrome next to the app's own inputs. They now share the input rule (same background, border, radius and focus accent), in a monospace face and without the resize grip that broke the dialog's layout.

## [0.6.0-alpha] - 2026-08-10

### Added
- **Browse every untracked session, and adopt one without a picker** — the inline "Recent · unmanaged" section shows the 30 newest, with no way to reach anything older. `discover_sessions_page` pages through the whole set and reports the full count, so **＋Import** (back, on the left of the list's filter row) can search and page through all of them, or take a pasted session id. Conversely, **Adopt** on a row no longer opens that picker: the session is already chosen, so the dialog only asks where it should land — a list there invited adopting a *different* session than the one clicked.
- **A session adopted from a row is named after its work** — the default name came from the folder, so anything started in `~/TomTom` was adopted as "TomTom". It now uses the session's own first prompt, clipped on a word boundary; the folder is only the fallback.
- **PRs and tickets are listed in the detail panel** — each on its own row, every entry clickable, instead of the tickets being appended to the Category line and the PRs living only as a toolbar icon.
- **`/route` — a Context Brief before you investigate** — reads this space's knowledge notes, your past session notes and (when a tracker is reachable) its tickets, and summarises what is already known *before* you open the code. It resolves which notes folder to read from the current session's **space**, so nothing is hardcoded and work and personal knowledge never mix; an unmanaged terminal reads them all and says so. Layout is discovered rather than assumed — a `20-Notes/` · `10-Areas/` vault is used as such, any other folder is scanned flat — so it works for someone who just pointed a space at a notes directory. The search itself lives in `skills/lib/route_search.py` (14 selftests) rather than inline in the skill: the version this was ported from passed its query and its vault path through environment variables that nothing ever exported, so every search silently scored zero and the skill reported "no match" for its entire life. Arguments cannot be forgotten the way an export can.

### Changed
- **One Edit button instead of a pencil per field** — each reference field had its own ✎ and popover, which turned the actions row into a wall of buttons for something you edit rarely. A single ✎ now opens one dialog for every editable field, and validates all of it before writing either — a half-applied save would leave the `notes.md` disagreeing with what the box showed.
- **Persistent memory no longer looks like an Obsidian feature** — the "vault" was always just a folder of Markdown: the session skills write notes into it, `/route` reads them back, and nothing in the code has ever touched Obsidian (no URI scheme, no plugin, no API). But the naming — an *Obsidian* toggle, an *Obsidian vault* path — meant anyone without Obsidian reasonably concluded the feature was not for them, and skipped persistent memory entirely. It is now **knowledge notes**: point a space at any folder of Markdown. The config key `obsidian` became `knowledge`, the legacy name is still read everywhere (Rust, the skills' Python helper, the Settings UI), and a config only gains the new name when the app next saves it — so nothing to change by hand. `roots[].vaultPath` keeps its name: "vault" is generic, and it is a path field, not the word that was turning people away.

### Fixed
- **Links in the embedded terminal are clickable** — Claude Code prints a PR it just opened as an **OSC 8 hyperlink**, not as plain text, so `WebLinksAddon`'s regex never saw it. xterm routes those through its `linkHandler` option, which defaults to `null`: the link rendered underlined and the click was swallowed, ⌘ or not. They now open in the browser. An OSC 8 target is attacker-controlled text, so its scheme is checked before opening — `open_external` (http/https only) remains the authoritative guard.
- **A refused link no longer fails in silence** — an unsupported scheme was rejected by the backend and the renderer dropped the rejection, so clicking did nothing at all, with no message. The same fault made **Load more** look dead: it was also always visible, because an author `display` beats the browser's `[hidden]` rule. Both are fixed, and clicks are now matched by the `data-url` attribute rather than by class — matching by class is what made a newly-added kind of link silently inert.
- **Feature bullets on the landing page broke into columns** — `.feature li` is a flex container, so a bullet containing a `<strong>` or a `<code>` laid its fragments out side by side instead of as one sentence.
- **The README says what `--force` is for** — it documented that the installer will not overwrite a customised skill, but never that this is exactly why a `git pull` leaves *changed* skills behind. The Session-skills section now states the rule (`git pull && bash scripts/install.sh --force`), notes that `npm run install:skills` does not force, and warns that the app's Settings button installs the bundle compiled into *your* binary — so a stale build reinstalls stale skills.
- **A repo pull no longer half-delivers a skill update** — the installer keeps an existing skill untouched without `--force`, so pulling a version that *changes* `/close-session` or `/save-session` left them on the old copy while the new skills and libs arrived. `scripts/install.sh` now diffs each skipped skill against the bundle and ends with an explicit warning naming the ones whose updates did not arrive (an identical copy stays silent). `/skills-review` makes the same failure self-diagnosing: when the learning loop is enabled but the installed session skills carry no proposal step, it says so instead of reporting "nothing pending" — the two look identical and mean opposite things. The installer's closing skill list is now derived from the directory rather than hand-maintained, which had already gone stale.

### Documentation
- **The pitch leads with the outcome** — the hero took three sentences to reach the product, and "mission control" names a metaphor rather than a result; the README and the site now open on *every agent you're running, in one window*. Adds the memory story (a `notes.md` outliving compaction) as its own section — the most defensible claim, and it appeared nowhere on the page — and corrects copy left stale by 0.4.0, which still advertised three views after Cards was removed.
- **The knowledge-notes tier is now advertised** — the README and the landing page told the per-session story (a `notes.md` that survives compaction) and stopped there; the tier that survives *across* sessions was documented nowhere, so no visitor could know it existed. Both now carry it, with the honest boundary drawn: distilling on close ships, and a dedicated Context-Brief command to read it back is named on the roadmap rather than implied.

## [0.5.0-alpha] - 2026-08-10

### Added
- **A staged skill-learning loop** — the session skills can now propose *procedural* knowledge back into `~/.claude/skills/`, the way `/distil` already promotes decisions to an Obsidian vault. Three new bundled skills:
  - **`/skill-propose`** stages what a session taught as a new skill, or (preferred) a targeted patch to an existing one. It fires only when the session actually taught something reusable — a complex task that succeeded, a dead end whose workaround is worth keeping, an approach the user corrected, a non-trivial workflow — and stays silent otherwise. Before creating anything it asks the only question that keeps a skill set from inflating: *what umbrella class does this serve, and would a maintainer write it as N skills or as one with N labelled subsections?*
  - **`/skills-review`** is the approval gate, and the **only** path by which a proposal becomes active. It shows the full content or a real diff first, and reports when the loop last produced anything so a silently dead loop is visible.
  - **`/skills-curate`** is the periodic pass over the whole collection — the vantage point from which a *cluster* is visible at all. It groups by prefix, names the umbrella, and stages merges, demotions to `references/`, or archives.
  - **Nothing is ever auto-applied, and nothing is ever deleted.** Proposals live in `~/.claude/skills-pending/`, which no session loads; the maximum destructive action is archiving into `~/.claude/skills/.archive/`, which is recoverable. Curation only ever moves skills it created itself (`origin: agent-proposed`) — hand-written and plugin skills are reported, never touched.
  - Off by default: the `/close-session` · `/save-session` hook is gated on `skillProposals: true` in the config, like the existing Obsidian distil.
- **Per-skill usage tracking** (`skills/lib/skill_usage.py`) — derives `use_count` and `last_activity_at` per skill from the transcripts' `attributionSkill` field, and runs the lifecycle `active → stale (30 d) → archived (90 d)` on real activity rather than on anyone's judgement. A never-used skill is protected by a grace floor: no usage is *absence of evidence*, not evidence of uselessness. Reading the transcripts rather than hooking the `Skill` tool is deliberate — a `PostToolUse` hook only sees skills the *agent* invoked, and would systematically undercount the ones you type yourself (`/close-session`, `/eod`). The first scan backfills months of history; later scans are incremental.

### Fixed
- **Patch proposals are machine-checked, not eyeballed** (`skills/lib/patch_apply.py`) — a replacement routinely contains its own ``` fenced blocks, and a three-backtick wrapper ended at the first inner fence, silently truncating it and writing broken instructions into a skill. The format now requires a five-backtick wrapper, and one shared applier refuses rather than guesses: a wrapper that is too short, an unclosed fence, an anchor that does not match exactly once, or a patch already applied. That last guard matters for the "insert before X" shape, where the anchor still matches after a first apply — re-running such a patch used to duplicate the insertion.

## [0.4.1-alpha] - 2026-08-10

A fix release, mostly from the first external users' feedback.

### Added
- **Resuming an archived session un-archives it** — Resume left the ARCHIVED marker in place, so the session showed under Running only while its process lived, then snapped straight back to Archived the moment its terminal died. The marker is now stripped on every resume path (detail buttons, terminal pill, embedded toggle), mirroring what `/restart-session` already did. A session you pick back up rejoins the normal lifecycle and lands in Closed when it stops.

### Fixed
- **iTerm2 hotkey windows are revealed properly** — *Reveal window* selected the session's tab but never showed the window, because a hotkey window is hidden by iTerm's own mechanism rather than being an ordinary window. It now uses iTerm's `reveal hotkey window`. This one silently caused a second bug: with the reveal appearing to do nothing, the natural move on the "already running" warning was *Open anyway* — which starts a second process on the same conversation and forks it.
- **Terminal link clicks no longer fail silently** — an unsupported URL scheme was rejected by the backend and the renderer dropped the rejection, so clicking such a link did nothing at all, with no message. Refused opens now surface. `file://` stays deliberately unsupported: terminal output is untrusted text, and a printed `file:///…/x.app` would launch on a single click.
- **`/restart-session` no longer leaves the notes and the registry disagreeing** — it registered the new session id in `active-sessions.json` but left the `notes.md` frontmatter `session_id` on the previous one. Since the dashboard resolves a historical card from that frontmatter, the card offered to resume the *old* conversation while the registry pointed at the new one, and the real session was findable only by its transcript id.
- **CI is green again** — `clippy::type_complexity` is an error under CI's `-D warnings`, which had left master red since 2026-07-22.

### Documentation
- **A TL;DR at the top of the README** and the gaps the first external users hit, filled in [the guide](docs/GUIDE.md): the embedded terminal is the intended way to run sessions (not merely an option), **Adopt** exists for sessions started outside the app, and one session means one process.

## [0.4.0-alpha] - 2026-08-03

### Added
- **Several PRs / tickets per session** — a task that spans two PRs (or an epic plus its sub-task) no longer has to pick one. The `notes.md` frontmatter gained optional `pr_links:` / `tickets:` lists next to the existing `pr_link:` / `ticket:` primaries (additive — nothing that already writes those keys changed). With more than one link the card's GitHub icon / ticket chip show a **count badge** (`+1`) and open a **picker popover** listing `owner/repo#123`; a single link still opens straight away as before. The inline editor is now **one entry per line** and is no longer REVIEW-only — any session with a `notes.md` can attach PRs or tickets, tickets included (new `set_tickets` write, same ADR-013 guards as `set_pr_links`: atomic, confined under a configured root, validated). `/save-session` and `/close-session` now **append** discovered PRs/tickets to those lists instead of only filling an empty field.

### Removed
- **The Cards view is gone** — it overlapped the Kanban board without being as useful, so the app is now **List + Board**. The `▦ Cards` toggle, the cards grid and its topbar/search/filter are removed; the `v` shortcut, which used to flip list ⇄ cards, now flips **list ⇄ board** (so one key gets you back out of the board). Card **density** (Detailed / Compact / Minimal) stays — it now applies to the list cards only, and the Settings preview renders a list card to match. The detail slide-over + scrim remain, used by the Board.

### Fixed
- **A session skill can no longer hijack the terminal it runs in** — `/start-session`, `/restart-session` and `/import-session` all bind the current terminal's session id to a `notes.md` in `active-sessions.json`, and each did so unconditionally. Run one in a terminal that already held *different* work and the previous entry was silently overwritten: the `notes.md` survived on disk, but that session vanished from the dashboard and from `/list-sessions`. All three now check what the id already pointed at and ask before proceeding, offering to do the work in a fresh terminal instead. (`/start-session`'s guard existed locally but had never been carried into the repo, so a `--force` skills install dropped it.)

### Changed
- **List view: pinned sessions float to the top of the whole column** — previously they floated per *space* (and, before that, per category), which defeated the point of a pin as your "current threads" shortlist. They now sit in one block at the top, cross-space, just below **⚡ Needs you** (blocked work still outranks a pin; a session that's both appears only under Needs you). No header and no category/space label on the cards — the filled bookmark stays the only marker.

## [0.3.1-alpha] - 2026-07-23

### Added
- **"Recent · unmanaged" section + Adopt** — a collapsible section at the top of the Running tab lists recently-active Claude Code sessions that aren't yet managed by the dashboard (on disk under `~/.claude`, no `notes.md`). It's **lazy** (discovered only when you expand it — never on the 5-second poll, so hundreds of on-disk sessions cost nothing) with a ↻ rescan. Each row has a single **Adopt** action = resume + register in one gesture, reusing the Import modal preselected on that session; once adopted, the row leaves the list. The old top-level **＋Import** button was removed — Adopt covers it inline.
- **List-view organization (drag to reorder + group)** — in the List view you can now **drag-reorder your categories** (persisted) and move the **Recent · unmanaged** block anywhere; **drag-reorder sessions** within their category; and **group related sessions** (e.g. sub-tickets of one parent) by **dragging one session onto another**, Kanban-style. Groups are collapsible, colour-coded by their category (board-style border), renamable via a pencil icon, and auto-dissolve below two members. Everything stays **within a category** (no cross-category moves) and is scoped to the Running tab. Clicking into a session's embedded terminal now **selects + reveals** its card in the list.
- **Per-session usage bar** — the footer bar's **context %** and **model** now follow the **selected session** instead of "whichever session last rendered its statusline". The bundled `ao-statusline.sh` writes a per-session keyed cache (`{ global, sessions: { <id> } }`); the app shows the selected session's context/model and hides them when a session has no data. The **5-hour / weekly** windows stay account-global. The legacy flat cache is still read, so nothing breaks on upgrade.

### Fixed
- **Usage bar no longer blanks after a resume** — Claude Code omits `rate_limits` on some renders (notably right after a resume); the wrapper now keeps the last-known 5h/7d values instead of clearing the bars.
- **macOS "damaged" on first open** — documented the real fix (`xattr -cr` to clear the Gatekeeper quarantine) in the README and release notes; the old "right-click → Open" no longer works on recent macOS.

## [0.3.0-alpha] - 2026-07-15

### Added
- **"Claude Desktop" group for unmanaged Desktop-app sessions** — a live session opened via the Claude Desktop app (not Claude Code CLI) has no `notes.md`/category, so it used to land in the generic "OTHER" group in List/Cards. It now groups under its own **"Claude Desktop"** label instead, based on the pidfile's `entrypoint`.
- **Usage status bar** — a slim bottom bar showing your **model**, the **5-hour** and **weekly** rate-limit windows (colour-coded, with reset countdowns), and the current **context %**. Works **automatically** for sessions launched from the dashboard: the app installs a bundled statusline wrapper (`~/.claude/ao-statusline.sh`) and injects it per-launch via `claude --settings` (never edits your global `settings.json`). The wrapper writes `~/.claude/statusline-cache.json`, which the app reads **read-only**, then delegates to your own statusline so your terminal display is unchanged. Hidden when no cache exists, dimmed when stale.
- **Bundled `/save-session` skill** — the repo now ships a generic `save-session` (checkpoint the active session into `notes.md` mid-flight, marked `(in progress)`, without closing it) alongside start/close/restart/archive/import/rename. README also documents an **opt-in** Stop hook that nudges you to `/save-session` as context fills (≈50/75/90%) — not auto-installed; the app never edits your global `~/.claude/settings.json`.
- **In-app session-skills installer** — the app now bundles the session skills (embedded at compile time) and can install/refresh them into `~/.claude/skills/` itself: a first-launch banner offers a one-click install when they're missing, and **Settings → Backup → Session skills** has an *Install / update skills* button (force-refresh, for after an app upgrade). A `.dmg`-only install is now self-sufficient — no git clone + `install.sh` needed. The installer also seeds a default config if absent and pre-creates the category folders. Writes only under `~/.claude/skills/`, user-triggered.
- **Linux support** 🐧 — runs on X11 and Wayland (verified on GNOME/Wayland); `cargo tauri build` produces `.deb`/`.AppImage`. External terminals resolve via `$TERMINAL`/`xdg-open` and the standard emulators; the macOS-only *reveal-existing-window* button is hidden on Linux. *(First external contribution — thanks [@FelixDombek-TomTom](https://github.com/FelixDombek-TomTom), #1.)*
- **CI + bundle-freshness guard** — a GitHub Actions workflow runs clippy/tests, and `npm run check:bundle` fails if the vendored `renderer/xterm-bundle.js` drifts from its source. *(Contributed by [@FelixDombek-TomTom](https://github.com/FelixDombek-TomTom), #2.)*
- **Import → v2 spaces** — the Import modal now picks a **space** (dropdown, like ＋New) instead of the old Work/Personal toggle, filters categories by space, and threads `--root` through `import_session` + the `/import-session` skill so the adopted notes.md lands under the chosen space.
- **Import by session ID** — paste a session ID to import one that isn't in the recent-transcripts list.
- **Import: Embedded / Terminal toggle** — adopt a session in the in-app terminal (keyed by its real id, links to the card with no re-key) or an external tab, sharing the `Open in` pref.

### Security
- **Rust security & robustness audit** — a full pass (Fable-assisted, each finding adversarially reviewed) hardened the backend; every change verified with clippy + the test suite green:
  - `alive()` now clamps a session's pid to `pid_t` range before the `kill(2)` cast — an oversized value from a foreign-written pidfile wrapped negative, and `kill(-pgid, 0)` probes a whole **process group**, so a dead session could read as *alive*.
  - `atomic_write` now `fsync`s the temp file before the rename (and `config::save` shares the one helper) — a crash in the writeback window could otherwise replace a good `notes.md`/config with an **empty** file.
  - `delete_session` refuses to remove a path that is a configured root or category directory (requires ≥2 levels below the longest matching root).
  - One `is_valid_session_id` + one `is_safe_slug` validator across `lib`/`reader`/`pty` — the sessionId/slug allowlists (which guard both shell-command folding and `{sid}.jsonl` path building, so nothing can traverse out of `~/.claude/projects`) now live in one audited place.

### Fixed
- **Active session showed a green (idle) dot while working** — Claude Code's pidfile `status` can lag (stays `idle` while the main loop is busy). The Running tab now infers **busy** when the session's transcript was written in the last few seconds, overriding a stale `idle` (`waiting`/`shell` left untouched).
- **Orphaned `claude` process on terminal-spawn failure** — if wiring the pty's I/O failed *after* the child spawned, the child ran unmanaged forever (never in the session map, so no kill could reach it) and its shell lingered as a zombie. It's now killed + reaped on that error path.
- **A session can reopen after its embedded terminal exits naturally** — the dead pty entry is reaped and dropped, so a later Resume/Restart isn't wrongly blocked as "already running".
- **`＋New` with a title that has no letters or digits** (e.g. "…" or accents-only) is now rejected in the form, instead of creating a mis-keyed session at `<base>/<CAT>//notes.md`.
- **Poll no longer renders under the wrong tab** — an in-flight refresh that finishes after you've switched tabs is discarded instead of painting stale rows.
- **Imported sessions classify correctly** — the bootstrap history line `/import-session` writes is now marked `(in progress)`, so an adopted session shows as active rather than mis-bucketed.
- **Git-info cache no longer grows unbounded** — entries for closed/vanished session cwds are evicted on insert (they used to accumulate for the app's lifetime).
- **Fresh-install accent didn't match the default look** — with no saved accent, the app fell back to a hardcoded electric blue instead of the default **Ardoise** look's slate, so a new install showed *Ardoise* selected but a blue accent (until you re-clicked it). The default accent now derives from Ardoise (`#7E93B8`).
- **"End session" left a session stale when it had a prior close entry** — `notes_closed_since` (the poll that tells End session the wrap-up landed, so it can kill the pty) returned true as soon as the notes.md was *touched* and its status was "closed" — but an older close entry already reads as "closed". So `/close-session`'s early section writes bumped the mtime and killed the pty before it appended today's close line → no fresh close → `reopened_after_close` (transcript touched today > the old close date) flipped it back to stale. It now requires the latest close entry to be dated **today**.
- **Age pill showed a stale timestamp after Pause** — Pause kills the pty without touching `notes.md`, so the notes file's mtime (`updatedAt`) could be days old even though you'd just worked the session today. The age (and "Last activity" tooltip) now takes the **more recent** of `updatedAt` (notes.md mtime) and `lastActivityAt` (the transcript's last message) rather than a fixed priority — and historical sessions (stale/closed/archived) now carry `lastActivityAt` too (previously only live ones did).
- **Lifecycle: age pill replaces the "stale" badge, new Pause action** — every card (Running, Closed, Archived) now shows a compact "⏱ 3d" age pill (time since last activity) in its icon row, instead of an alarming "stale" text badge (the detail panel's status word is now the calmer "IDLE"). A new **Pause** button (⏸, shown when a session has a live embedded terminal) kills just that terminal — no wrap-up, no close marker — so the session goes idle but **stays in Running**, ready to Resume later. Distinct from **Close** (done → Closed tab): Pause is for "I'll come back to this," Close is for "finished, pending review."
- **Resume offered for stub sessions** — a `/start-session` stub leaves `session_id` as a `to fill (…)` placeholder, so the dashboard only ever offered *Restart*. The reader now falls back to the latest real session id registered to that notes.md in `active-sessions.json` (whose transcript still exists), so **Resume** is offered when a resumable transcript is available.
- **Embedded terminal re-reveal survives resume (no more false "already running")** — a session resumed twice gets a new sessionId each time, but its terminal was keyed by the *old* sid, so after switching away the dashboard couldn't re-find it → it warned "already running" and offered a 2nd instance. Terminals are now tagged with their (stable) `notes.md` path and re-found by it, regardless of the current sid. Resume/Restart re-reveal the backgrounded terminal instead of warning.
- **Close button on stale sessions** — a stale session in the Running tab now shows a **Close** button (it used to wrongly show *Archive*). Click → it moves to **Closed** (stamps a close marker via `close_session`, no skill needed). Lifecycle granularity is now Running/Stale → **Close** → Closed → **Archive** → Archived. The *stale* badge stays until you close it, so sessions that were never `/close-session`'d stay trackable.
- **`/close-session` always records a close** — it no longer "no-ops" when there's nothing new since the last close; it appends a close entry dated **today** (skipping only a same-day duplicate). So a resumed-then-closed session reliably lands in **Closed** — and the *End session* button detects it immediately instead of waiting for its timeout.
- **"End session" now closes with an AI wrap-up — and always lands in Closed** — the embedded terminal's *End session ✕* button used to just kill the process, leaving the session **stale** (nothing written to notes.md). It now injects `/close-session` (submitted with `\r`) so Claude writes the full summary, polls until that close is recorded, then kills the pty → **Closed** with a real wrap-up. If no fresh wrap-up appears within the timeout (nothing new to summarise, or the session is in plan mode), it **stamps a close marker directly** (like Archive) and ends → still **Closed**, never stale. A second click ends immediately.
- **Resume/Restart now launch in `--permission-mode auto`** — previously only `+New`/Import did. If your default is **plan mode**, a resumed session started in plan, so `/close-session` and `/save-session` (which write `notes.md`) bailed at their plan-mode check — the close never recorded and the session lingered as **"stale"** in Running. All four launch sites (Resume/Restart × embedded/external) now force auto, matching `+New`.
- **Resumed archived/closed session showed as "OTHER"** — the Running tab resolved category/root only from `active-sessions.json` (by session id), so a session resumed after being archived/closed (de-registered) appeared uncategorised with no workspace. It now relinks to the managed `notes.md` whose history records that `session=<id>`, recovering category/ticket/root — and is excluded from its historical bucket while live (no double-listing).
- **Embedded `+New` terminal — false "already running"** — resuming a `+New` session (whose terminal is keyed by `notesPath`) checked liveness only by `sessionId`, so it warned "already running" instead of re-revealing the backgrounded terminal. It now matches either key and re-reveals.
- **`/close-session` relink** — a resumed session whose id isn't in `active-sessions.json` now finds its `notes.md` via the `session=<id>` history line (so the close records in the right place), and no longer falls back to "most recently modified session" (which could mis-route the close to a different session).
- **Import** launches the resumed session in **auto mode** (`--permission-mode auto`) so `/import-session` can write — plan mode was silently blocking the adoption.
- **False "Archived"** — a session was wrongly filed under Archived when the *word* "archived" appeared anywhere in its `notes.md` history (so the dashboard's own project, whose notes discuss archiving, kept self-archiving). The classifier now matches only the genuine `| ARCHIVED |` marker that `/archive-session` writes.
- **Archived/Closed status dot** — these showed a green ("running") dot in the List/Cards; they now use the muted grey *historical* dot (they aren't running).

## [0.2.2-alpha] - 2026-06-22

### Added
- **Start a new session in the embedded terminal** — ＋New now offers the same **Embedded / Terminal** destination toggle as Resume/Restart (shared `Open in` pref), so a brand-new session can open in the built-in terminal instead of an external iTerm tab.
- New sessions launch in **auto mode** (`--permission-mode auto`) so `/start-session` can write its workspace without being blocked by plan mode.

### Fixed
- **Embedded terminal — Shift+Enter** now inserts a newline instead of submitting (the Enter was leaking through and submitting).
- **Embedded terminal — scrolling** no longer intermittently sticks: the wheel drives xterm's `scrollLines` directly, bypassing a WKWebView canvas-viewport stall.
- **No white flash on window resize** — the webview is non-opaque and the native window background tracks the theme, so the growing edge shows the theme colour instead of the OS-default white.
- **rename-category** refuses to rename a category that exists under multiple spaces (it would have renamed only one and left the config inconsistent) — remove the duplicate first.
- **Session → space tagging** uses component-aware path matching, so a session under `FEAT-bug/` is no longer mis-tagged as belonging to `FEAT`.

## [0.2.1-alpha] - 2026-06-22

### Added
- **Spaces editor in Settings** — rename a space, set its folder (Browse), add/remove. Renaming a space retags the categories under it; each space shows its selected path on its own line.
- **Category colours from a seed + scheme** — the same generative system as the board (Spectrum / Shades / Analogous): pick a seed and the per-category colours fill from it.
- **Resizable Settings modal** — drag the corner; up to +20% wider and taller until everything fits.
- **Unified ⚲ Filter** — the filter popover now filters by **Space** *and* **Category** (the board's separate space selector was removed).

### Changed
- **List view** — pinned sessions float to the top of *each space* (no "PINNED" header); per-card space labels removed (the section header is the only space marker); the ticket/PR/notes icons sit flush-left under the title.

### Fixed
- **Restart** — closed/archived sessions restart in their **space root** (resolved from the session's `notes.md` location), not `$HOME`.
- **Board** — an empty, in-creation note no longer shows a delete trash; Escape / click-away cancels it.

## [0.2.0-alpha] - 2026-06-22

### Added
- **Spaces** — categories can live under multiple named spaces (e.g. *Work*, *Perso*, a client) instead of the fixed work/personal pair. **List & Cards** organise into collapsible **space sections** → category groups; the **Board** gets its own space filter next to its search; pinned / ⚡ waiting cards (which float out of their section) keep a small space tag. A category that exists in 2+ spaces (e.g. `AI-SYSTEM` under both Work and Perso) is fully supported — `＋New` has a **space dropdown** that picks which one a session lands under, and `start_session` + the `start-session` skill resolve the folder via the chosen space. Config schema v2: `roots: [{name,path}]` + a `root` per category, migrated transparently from the legacy `workRoot`/`personalRoot` + `scope`. *(A Spaces editor in Settings is still to come — add spaces by editing the config / folder picker meanwhile.)*
- **⚲ Filter popover** — the per-category chip row became a single **⚲ Filter** button + checkbox menu (deduped categories, active-count badge, one control across List/Cards/Board).
- **Import existing sessions** — a `＋Import` picker lists your recent *unmanaged* Claude Code sessions (searchable); pick one and it resumes (`claude --resume`) and is adopted into management (writes `notes.md` + registers it) under a chosen root/category. Backed by a new `discover_sessions` command and an `/import` skill. Picker hides slash-command/skill one-off runs and sub-agent sidechains.
- **Kanban board: category filters + search** — same controls as the List/Cards views, on a single filter bar.
- **Ticket as a number label** — tickets render as a clickable `PROJ-123` chip in the List, Cards, and Board (was a bare icon); clickable when a tracker URL is set, a plain label otherwise.
- **Guide + FAQ** — `docs/GUIDE.md` (session lifecycle, Start vs Resume vs Restart, notes-beat-compaction diagram) and a README FAQ on what shows up automatically vs. needs importing.
- README version badge.

### Changed
- **Licence → AI Agents Orchestrator Source Available License v1.0** (was PolyForm Noncommercial, which barred use at a for-profit). Now free to download, use, and evaluate — including in the course of professional work at a company — while prohibiting resale, redistribution, org-wide deployment, SaaS offerings, rebranding, and modified-version distribution without written permission.
- **Session skills renamed** (follows Claude's skill-naming conventions — generic single-word names are discouraged): `/start`→`/start-session`, `/close`→`/close-session`, `/restart`→`/restart-session`, `/archive`→`/archive-session`, `/import`→`/import-session` (`/rename-category` unchanged). The dashboard launcher emits the new names. **Re-run `bash scripts/install.sh --force`** and use the new commands.
- **Session skills are root-aware** — `aoconfig.py` resolves a session's folder from its category's root (with the legacy work/personal layout still supported). **Re-run `bash scripts/install.sh --force`** to update the bundled skills.
- **Board cards** — the title gets its own row; status badges + action icons moved to a foot row; the branch chip was dropped; the `STALE` badge is now the muted grey used in the List.
- **Positioning** — hero/README reframed around *AI development sessions* (mission control for the sessions you already run), not agent-spawning.
- Pre-Tauri ADRs (001–011) are clearly marked **Historical (Electron era)**; the app runs on Tauri.

### Fixed
- **`/restart` un-archive** — the revive step matched the substring `ARCHIVED` anywhere in a line and could strip legitimate `notes.md` history/decision bullets that merely mention the word. It now strips only a genuine archive marker (a `… | ARCHIVED | …` Session-history bullet).
- **Lifecycle classification** — a properly `/close`d session no longer lingers as *stale*: the classifier recognises the current `… | session=<id> | …` history format and reads the **newest-dated** entry (not the last physical line, which could be out of order).
- **Embedded terminal** — status dot updates live on the poll; returning to the List from the Board restores the open terminal; Resume/Restart route to the List view; the ⓘ info button works over the terminal.
- **Board inline editing** — Escape cancels a column/group rename or note edit (and a freshly-added empty note is removed instead of left as an orphan); the rename input survives the 5-second poll.
- **Import picker** — Escape closes it; cleaner derived titles; modal width fixed.
- **Mobile landing** — the "View on GitHub" button no longer wraps to two lines.

[Unreleased]: https://github.com/t-mercier/ai-agents-orchestrator/compare/v0.2.1-alpha...HEAD
[0.2.1-alpha]: https://github.com/t-mercier/ai-agents-orchestrator/compare/v0.2.0-alpha...v0.2.1-alpha
[0.2.0-alpha]: https://github.com/t-mercier/ai-agents-orchestrator/releases/tag/v0.2.0-alpha
