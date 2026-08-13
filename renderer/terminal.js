/* global XtermBundle */
const { Terminal, FitAddon, WebLinksAddon } = XtermBundle

const terminals = new Map()  // sessionId → { term, fitAddon, div }
let activeTerminalSession = null
let terminalVisible = false

const XTERM_THEME = {
  background:    '#1c1c1e',
  foreground:    'rgba(255,255,255,0.85)',
  cursor:        '#0a84ff',
  cursorAccent:  '#1c1c1e',
  selectionBackground: 'rgba(10,132,255,0.25)',
  black:         '#1c1c1e',  red:     '#ff453a',
  green:         '#30d158',  yellow:  '#ffd60a',
  blue:          '#0a84ff',  magenta: '#bf5af2',
  cyan:          '#5ac8fa',  white:   'rgba(255,255,255,0.85)',
  brightBlack:   '#636366',  brightRed:     '#ff6961',
  brightGreen:   '#34c759',  brightYellow:  '#ffd426',
  brightBlue:    '#409cff',  brightMagenta: '#da8fff',
  brightCyan:    '#70d7ff',  brightWhite:   '#ffffff',
}

// ── Embedded-terminal appearance prefs (Settings → Terminal tab) ──
// Live, client-side (localStorage 'csm.terminal'), like theme/accent — folds into
// the durable prefs file (#18) later. Applied to new terminals at creation and to
// every open terminal on change.
const TERMINAL_FONTS = {
  fira:      "'Fira Code', monospace",
  jetbrains: "'JetBrains Mono', monospace",
  sfmono:    'ui-monospace, monospace',   // resolves to real SF Mono on macOS
  menlo:     'Menlo, monospace',
  monaco:    'Monaco, monospace',
}
const TERM_DEFAULTS = { font: 'fira', fontSize: 12, bg: '#1c1c1e', fg: '#d9d9d9' }
function fontFamilyFor(key) { return TERMINAL_FONTS[key] || TERMINAL_FONTS.fira }
function getTerminalPrefs() {
  let p = {}
  try { p = JSON.parse(localStorage.getItem('csm.terminal') || '{}') } catch (_) {}
  return { ...TERM_DEFAULTS, ...p }
}
function termTheme(prefs) {
  return { ...XTERM_THEME, background: prefs.bg, foreground: prefs.fg }
}
// Apply current prefs to every open terminal (font/size change → refit + resize pty).
function applyTerminalPrefs() {
  const prefs = getTerminalPrefs()
  const ff = fontFamilyFor(prefs.font)
  terminals.forEach((entry, sid) => {
    entry.term.options.fontFamily = ff
    entry.term.options.fontSize = prefs.fontSize
    entry.term.options.theme = termTheme(prefs)
    if (entry.opened) {
      try {
        entry.fitAddon.fit()
        window.api.ptyResize(sid, entry.term.cols, entry.term.rows)
      } catch (_) { /* terminal not measurable right now */ }
    }
  })
}
function setTerminalPrefs(partial) {
  const next = { ...getTerminalPrefs(), ...partial }
  try { localStorage.setItem('csm.terminal', JSON.stringify(next)) } catch (_) {}
  applyTerminalPrefs()
}
window.getTerminalPrefs = getTerminalPrefs
window.setTerminalPrefs = setTerminalPrefs
window.applyTerminalPrefs = applyTerminalPrefs

// Wire incoming pty data to the right xterm instance
window.api.onPtyData((sessionId, data) => {
  const entry = terminals.get(sessionId)
  if (entry) entry.term.write(data)
})

// When the pty dies (claude/shell exited, or killed by last-window-close),
// dispose this window's xterm so it can't leak (ADR-010). If the terminal is
// currently visible, keep the pane and show a banner — it disposes on close.
window.api.onPtyExit((sessionId) => {
  const entry = terminals.get(sessionId)
  if (!entry) return
  if (activeTerminalSession === sessionId && terminalVisible) {
    entry.term.write('\r\n\x1b[2m[session ended — close to dismiss]\x1b[0m\r\n')
  } else {
    entry.term.dispose()
    entry.div.remove()
    terminals.delete(sessionId)
  }
})

function ensureTerminal(sessionId, restartSlug = '', command = '') {
  if (terminals.has(sessionId)) return terminals.get(sessionId)

  const container = document.getElementById('detail-terminal-pane')
  const div = document.createElement('div')
  div.className = 'terminal-session-div'
  div.dataset.terminalFor = sessionId
  div.style.display = 'none'
  container.appendChild(div)

  const prefs = getTerminalPrefs()
  const term = new Terminal({
    theme: termTheme(prefs),
    fontFamily: fontFamilyFor(prefs.font),
    fontSize: prefs.fontSize,
    lineHeight: 1.0,   // default spacing — 1.15 looked off
    cursorBlink: true,
    allowTransparency: false,
    scrollback: 5000,
    // OSC 8 hyperlinks — how Claude Code prints a PR it just opened, and how modern CLIs
    // emit links generally. These are NOT plain text, so WebLinksAddon's regex never sees
    // them: without a linkHandler xterm renders them underlined and does nothing on click.
    // An OSC 8 target is attacker-controlled text: any command, repo or agent output can
    // emit one. open_external is the authoritative guard (it rejects anything but http(s)),
    // but check here too so a bad scheme is refused with a clear message rather than a
    // generic backend error — and so the renderer stays safe if that guard ever loosens.
    linkHandler: {
      activate: (_event, text) => {
        let url
        try { url = new URL(text) } catch { console.warn(`ignoring malformed link: ${text}`); return }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          console.warn(`refusing to open a non-http(s) link: ${text}`)
          return
        }
        window.api.openExternal(url.toString()).then(res => {
          if (res && res.ok === false) console.warn(`could not open ${text}: ${res.error}`)
        })
      },
    },
  })
  const fitAddon = new FitAddon()
  // Route terminal link clicks to the system default browser (not an Electron window)
  const webLinksAddon = new WebLinksAddon((event, uri) => {
    // Surface a refused open (unsupported scheme) instead of the click doing nothing.
    window.api.openExternal(uri).then(res => {
      if (res && !res.ok) console.warn(`could not open ${uri}: ${res.error}`)
    })
  })
  term.loadAddon(fitAddon)
  term.loadAddon(webLinksAddon)
  // Make absolute file paths ⌘-clickable too (the WebLinksAddon only does web URLs).
  // ⌘+click opens the path in its default app (a folder opens in Finder) via open_path.
  // NB: manual "is this part of a URL / mid-word?" check instead of a regex lookbehind —
  // older WKWebView builds don't support lookbehind, and a regex syntax error there would
  // break the whole renderer.
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1)   // provideLinks y is 1-based
      if (!line) return cb(undefined)
      const text = line.translateToString(true)
      const re = /(?:~\/|\/)[\w@.+\-/]+/g
      const links = []
      let m
      while ((m = re.exec(text)) !== null) {
        const before = m.index > 0 ? text[m.index - 1] : ''
        if (/[\w:/]/.test(before)) continue              // skip http(s):// + mid-word slashes
        const path = m[0].replace(/[.,;:!?)\]}>]+$/, '')  // drop trailing punctuation
        if (path.length < 3) continue
        const startX = m.index + 1                        // 1-based column
        links.push({
          range: { start: { x: startX, y }, end: { x: startX + path.length - 1, y } },
          text: path,
          activate() {
            const home = window.CSM_CONFIG && window.CSM_CONFIG.home
            const abs = path.startsWith('~/') && home ? home + path.slice(1) : path
            window.api.openPath(abs)
          },
        })
      }
      cb(links.length ? links : undefined)
    },
  })
  // NB: term.open() is deferred to showTerminal, once the div is visible.
  // Opening while the div is display:none makes xterm measure a 0×0 char cell,
  // so FitAddon.fit() bails out (proposeDimensions returns undefined for a
  // zero cell width) and the terminal is stuck at its 80×24 default.

  // Shift+Enter → insert a newline instead of submitting. Two parts:
  //  1) e.preventDefault(): returning false alone made xterm skip ITS handling but it
  //     didn't preventDefault, so the browser still fired the Enter → a \r leaked through
  //     and submitted (every injected sequence submitted because of this leak, even ones
  //     with no \r). preventDefault on keydown kills that (and the keypress it spawns).
  //  2) Send a bracketed paste of a literal LF — Claude inserts pasted newlines verbatim
  //     (its multiline-paste behaviour), so this is a real line break, not a submit.
  //     (NB: term.paste('\n') can't be used — it normalises \n → \r in its paste prep.)
  term.attachCustomKeyEventHandler(e => {
    if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      window.api.ptyInput(sessionId, '\x1b[200~\n\x1b[201~')
      return false
    }
    return true
  })

  term.onData(data => {
    window.api.ptyInput(sessionId, data)
  })

  // Wheel-scroll is left to the DOM renderer's native viewport. (An earlier custom
  // wheel→scrollLines handler was a workaround for the canvas renderer freezing in
  // WKWebView; now that we're on the DOM renderer the native scroll works, and the
  // handler only got in the way — it preventDefault'd the native scroll.)

  const entry = { term, fitAddon, div, rendererAddon: null, spawned: false, opened: false, restartSlug, command }
  terminals.set(sessionId, entry)
  return entry  // term.open + pty spawn happen in showTerminal, once the div is visible
}

function showTerminal(sessionId, cwd, restartSlug = '', command = '') {
  document.querySelectorAll('.terminal-session-div').forEach(el => {
    el.style.display = 'none'
  })
  const entry = ensureTerminal(sessionId, restartSlug, command)
  entry.div.style.display = 'flex'
  const fitSpawn = () => {
    if (!entry.opened) {
      // First reveal: open now that the div is laid out + visible, so xterm
      // measures a real char-cell size and fit() can compute the right columns.
      entry.term.open(entry.div)
      entry.opened = true
      // Renderer: xterm's default DOM renderer. The CanvasAddon renders crisper glyphs
      // (integer-pixel cell metrics), but it PAUSES in WKWebView — it stops repainting
      // until a redraw is forced (e.g. a drag-selection). That broke wheel-scroll (the
      // position moved but the frozen canvas didn't show it) AND link hover/⌘-click (the
      // link underline never repainted, so no link was "active" to open). The DOM renderer
      // repaints on every change, so scroll + links work. (WebGL was even flakier here.)
    }
    entry.fitAddon.fit()
    if (!entry.spawned) {
      // Spawn at the measured size so the first render fills the width. A non-empty
      // restartSlug makes the pty run `/restart <slug>` instead of `--resume`.
      window.api.ptySpawn(sessionId, cwd, entry.term.cols, entry.term.rows, entry.restartSlug, entry.command)
      entry.spawned = true
    } else {
      window.api.ptyResize(sessionId, entry.term.cols, entry.term.rows)
    }
    entry.term.focus()
  }
  // Wait for fonts (char-cell width must be measured with the real monospace
  // font, else fit() under-counts columns) + a frame for layout to settle.
  const fontsReady = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()
  fontsReady.then(() => requestAnimationFrame(fitSpawn))
  activeTerminalSession = sessionId
}

function openTerminalPane(sessionId, cwd, restartSlug = '', command = '', notesPath = '') {
  const infoPane = document.getElementById('detail-info-pane')
  const termPane = document.getElementById('detail-terminal-pane')
  infoPane.style.display = 'none'
  termPane.style.display = 'flex'
  terminalVisible = true
  showTerminal(sessionId, cwd, restartSlug, command)
  // Tag the terminal with its managed notes.md (stable across resume sid-changes). A
  // session resumed twice gets a new sessionId each time, but its notesPath is constant —
  // so we can re-find a backgrounded terminal by notesPath even when its Map key is an
  // older sid. Set once (first open); re-reveals pass no notesPath and keep the original.
  const entry = terminals.get(sessionId)
  if (entry && notesPath && !entry.notesPath) entry.notesPath = notesPath
  // Resuming makes the session live → let app.js remember it (so the panel
  // survives the Closed→Running migration) and flip the view to Running.
  if (window.onTerminalOpened) window.onTerminalOpened(sessionId)
}

// Find a live (backgrounded) terminal by its managed notes.md, regardless of the Map key
// (which may be an older sessionId from a previous resume). Returns the key, or null.
function terminalKeyForNotes(notesPath) {
  if (!notesPath) return null
  for (const [key, entry] of terminals) {
    if (entry.notesPath === notesPath) return key
  }
  return null
}

// Stop SHOWING the terminal without killing it — the xterm + Rust pty stay alive
// in the terminals Map so the session keeps running in the background and can be
// re-revealed later. This is what switching sessions / toggling ⌨ off does, so
// multiple embedded terminals can run in parallel.
function hideTerminalPane() {
  const infoPane = document.getElementById('detail-info-pane')
  const termPane  = document.getElementById('detail-terminal-pane')
  termPane.style.display = 'none'
  infoPane.style.display = ''
  terminalVisible = false
  activeTerminalSession = null
}

// The terminal key is a notesPath (embedded +New) or a sessionId (Resume/Restart) —
// resolve the session's notes.md so we can wrap it up on End.
function notesPathForKey(key) {
  if (key && key.endsWith('/notes.md')) return key
  const s = (window._lastSessions || []).find(x => x.sessionId === key)
  return (s && s.notesPath) || ''
}

// Kill the pty + dispose the xterm for `sid`, then restore the view. The hide is guarded
// on `sid` still being the active one, so an async End that completes after the user
// switched away doesn't yank a different session's terminal.
function killTerminal(sid) {
  try {
    if (sid) {
      // Kill the pty FIRST — ending is the whole point, and must not be skipped if xterm
      // teardown throws (renderer-addon disposal can hiccup in WKWebView).
      try { window.api.ptyKill(sid) } catch (e) { console.error('ptyKill failed:', e) }
      const entry = terminals.get(sid)
      if (entry) {
        try { entry.term.dispose() } catch (e) { console.error('xterm dispose failed:', e) }
        entry.div.remove()
        terminals.delete(sid)
      }
    }
  } finally {
    if (activeTerminalSession === sid) hideTerminalPane()
    if (window.onTerminalClosed) window.onTerminalClosed()
  }
}

// "Close session ✕": close the session WITH an AI wrap-up, then end it. Injects
// /close-session into the live pty so claude writes the full summary to notes.md, polls
// until that close is recorded, then kills the pty → the session lands in Closed (not
// stale). Wired only to the explicit "Close session ✕" button — switch / ⌨ toggle / drawer
// close merely hide (pty stays alive). Falls back to a plain kill for an unmanaged session
// (no notes.md), and offers "end anyway" if the wrap-up never lands (e.g. plan mode).
// Guarantee the session lands in Closed: if /close-session didn't write a fresh wrap-up
// (nothing new to summarise, or plan mode), stamp a close marker directly, then kill the
// pty. So End ALWAYS → Closed, never stale.
async function endNow(sid, notesPath, msg) {
  const entry = terminals.get(sid)
  if (entry && msg) { try { entry.term.write(`\r\n\x1b[2m${msg}\x1b[0m\r\n`) } catch (_) {} }
  if (notesPath && window.api.closeSession) {
    try { await window.api.closeSession(notesPath) } catch (_) { /* fall through to kill */ }
  }
  killTerminal(sid)
}

const ending = new Set()
function closeTerminalPane() {
  const sid = activeTerminalSession
  if (!sid) { hideTerminalPane(); return }
  const notesPath = notesPathForKey(sid)
  // Second click while a wrap-up is in flight = end now (stamp a close, no AI summary).
  if (ending.has(sid)) { ending.delete(sid); endNow(sid, notesPath, '[ending now — closing without a summary]'); return }
  // Unmanaged session (no notes.md): nothing to wrap up — just kill.
  if (!notesPath || !window.api.notesClosedSince) { killTerminal(sid); return }

  ending.add(sid)
  const since = Date.now()
  const entry = terminals.get(sid)
  if (entry) entry.term.write('\r\n\x1b[2m[ending — writing wrap-up via /close-session… closes once it is saved]\x1b[0m\r\n')
  // Submit with a carriage return (\r = Enter). A \n is a line feed → claude's TUI inserts
  // a newline in the input instead of submitting, so the command would just sit there.
  window.api.ptyInput(sid, '/close-session\r')

  const POLL = 2000, TIMEOUT = 75000
  let waited = 0
  const iv = setInterval(async () => {
    if (!terminals.has(sid)) { clearInterval(iv); ending.delete(sid); return }  // pty already gone
    waited += POLL
    let closed = false
    try { closed = await window.api.notesClosedSince(notesPath, since) } catch (_) { /* keep polling */ }
    if (closed) {
      // /close-session wrote a fresh wrap-up → already Closed, just kill.
      clearInterval(iv); ending.delete(sid); killTerminal(sid)
    } else if (waited >= TIMEOUT) {
      // No fresh wrap-up (nothing new / plan mode): stamp a direct close → still Closed.
      clearInterval(iv); ending.delete(sid)
      endNow(sid, notesPath, '[no new work to summarise — closed from the dashboard]')
    }
  }, POLL)
}

// Is there a live (alive, possibly-backgrounded) terminal for this session?
function hasLiveTerminal(sessionId) {
  return terminals.has(sessionId)
}

function toggleEmbeddedTerminal(sessionId, cwd, restartSlug = '', notesPath = '') {
  if (terminalVisible && activeTerminalSession === sessionId) {
    hideTerminalPane()   // background it (pty stays alive); "Close session ✕" kills
  } else {
    openTerminalPane(sessionId, cwd, restartSlug, '', notesPath)
  }
}

function fitActiveTerminal() {
  if (!terminalVisible || !activeTerminalSession) return
  const entry = terminals.get(activeTerminalSession)
  if (!entry) return
  entry.fitAddon.fit()
  window.api.ptyResize(activeTerminalSession, entry.term.cols, entry.term.rows)
}

window.addEventListener('resize', fitActiveTerminal)

// Fit whenever the terminal pane actually changes size — fixes the terminal
// rendering at ~3/4 size on open (layout not settled when we fit in rAF).
const termPaneEl = document.getElementById('detail-terminal-pane')
if (termPaneEl && 'ResizeObserver' in window) {
  new ResizeObserver(() => fitActiveTerminal()).observe(termPaneEl)
}

window.toggleEmbeddedTerminal = toggleEmbeddedTerminal
window.openTerminalPane = openTerminalPane
window.terminalKeyForNotes = terminalKeyForNotes
window.hideTerminalPane = hideTerminalPane
window.closeTerminalPane = closeTerminalPane
// "Pause" toolbar button — kill the CURRENTLY SHOWN terminal directly, no /close-session
// injection, no close marker. Mirrors the list/card Pause action but from inside the
// terminal itself. The session goes idle and stays in Running for a later Resume.
window.pauseActiveTerminal = () => {
  if (activeTerminalSession) killTerminal(activeTerminalSession)
  if (window.refreshSessions) window.refreshSessions()
}
window.hasLiveTerminal = hasLiveTerminal
// "Pause" (list/card action, no wrap-up): kill a session's live embedded terminal by its
// Map key WITHOUT any /close-session injection — the session just goes idle (dead pid),
// stays in Running. Handles both the visible pane (hides it) and a backgrounded one.
window.killTerminal = killTerminal
window.fitActiveTerminal = fitActiveTerminal
window.getTerminalVisible = () => terminalVisible
