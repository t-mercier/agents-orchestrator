// Detached single-session window. Finds the session by key across all tabs and
// renders the same detail panel + embedded terminal as the main window.
const targetKey = new URLSearchParams(location.search).get('key')
const POLL_INTERVAL = 5000

function keyOf(s) { return s.notesPath || s.sessionId || s.name || '' }

async function findSession() {
  // Try running first, then closed, then archived
  const running = await window.api.getSessions()
  let found = running.find(s => keyOf(s) === targetKey)
  if (found) return { session: found, tab: 'running' }
  for (const tab of ['closed', 'archived']) {
    const list = await window.api.getHistoricalSessions(tab)
    found = list.find(s => keyOf(s) === targetKey)
    if (found) return { session: found, tab }
  }
  return { session: null, tab: 'running' }
}

async function refresh() {
  try {
    // The detached window has its own JS context, so it needs its own copy of the PR
    // cache — without it every PR here would read `unknown` while the main window
    // shows the real state.
    if (window.api.getPrStatus) window._prStatus = (await window.api.getPrStatus()) || {}
    const { session, tab } = await findSession()
    if (session) {
      document.getElementById('win-title').textContent = session.name || 'Session'
      window.renderDetailPanel(session, tab)
      window.attachDetailEventListeners()
    }
  } catch (err) {
    console.error('detached refresh failed:', err)
  }
}

// Pin toggle: keep this detached window above other apps, on demand.
// NB: named pinWindowBtn (not pinBtn) — ui.js declares a top-level `function
// pinBtn`, and both scripts share the global scope in detail.html, so reusing
// the name is a redeclaration SyntaxError that kills this whole file.
let pinned = false
const pinWindowBtn = document.getElementById('pin-window-btn')
if (pinWindowBtn) {
  pinWindowBtn.addEventListener('click', async () => {
    pinned = await window.api.setAlwaysOnTop(!pinned)
    pinWindowBtn.classList.toggle('active', pinned)
    pinWindowBtn.title = pinned ? 'Unpin (allow other windows on top)' : 'Keep this window on top'
  })
}

refresh()
setInterval(refresh, POLL_INTERVAL)
