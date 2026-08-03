# Screenshot regeneration

`docs/media/*.png` is generated, not hand-captured. Run this after any UI change that
alters what the docs show — a toolbar button, the card layout, the settings panel:

```bash
./scripts/screenshots/capture.sh              # every shot → docs/media/
./scripts/screenshots/capture.sh hero board   # only those scenes
OUT=/tmp/shots ./scripts/screenshots/capture.sh   # dry run, writes elsewhere
```

Env: `CHROME` (browser binary, auto-detected on macOS + Linux), `PORT` (default 8752),
`OUT` (default `docs/media`).

## How it works

It does **not** screenshot the packaged app — that would put your own sessions in the
docs. It serves `renderer/` (the very files the app ships) to headless Chrome with the
Rust backend stubbed by [`fixture.js`](fixture.js), which supplies a synthetic set of
sessions. So the output is the real UI, is reproducible, and leaks nothing.

`renderer/index.html` is **not** copied here — `capture.sh` derives the scene page from
it at run time, injecting a `<base>` and the fixture. A vendored copy would silently
drift from the real file. The script asserts on the two anchors it patches, so it fails
loudly if `index.html` moves them.

| Scene | Output | Shows |
|---|---|---|
| `list` | `hero.png` | List view, a waiting session selected |
| `light` | `light.png` | same, light theme |
| `rose` | `look-rose.png` | same, "Rose Poudré" look |
| `board` | `board.png` | Board: a group, an urgent flag, attached notes |
| `settings` | `settings.png` | Settings → Appearance over the board |
| `terminal` | `terminal.png` | Embedded terminal, output pushed through the real `pty-data` path |
| `banner` | `banner.png` | The landing page itself — runs **last**, it embeds the fresh `hero.png` |

Add a shot: add a scene to `fixture.js`, then a `scene:file:w:h` line to `SHOTS` in
`capture.sh`.

## Two things that will look like bugs

- **Chrome hangs after writing the PNG.** The page keeps a live event loop (the app
  polls every 5s), so Chrome's virtual-time budget never drains and it won't exit on its
  own. `capture.sh` launches it detached, waits for the file size to settle, then kills
  it. The fixture also clears pending timers once a scene is set, which is what lets the
  screenshot fire at all.
- **A full-height capture of the landing page comes out black.** `docs/index.html` fades
  its sections in on scroll (IntersectionObserver), so anything below the viewport is
  transparent at capture time. Shoot it at viewport height (as `banner` does) and verify
  the rest through the DOM.

## Fidelity notes

The dataset intentionally reuses the session names and copy of the original screenshots
(`checkout-redesign`, `payments-api`, …) so regenerated docs stay visually continuous.
Timestamps come from the clock at capture time, so the "LAST UPDATE" line and the age
pills change run to run — those pixels are the only non-deterministic part.
