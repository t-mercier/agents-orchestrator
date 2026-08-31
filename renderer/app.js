let sessions = []
let selectedKey = null   // unique session key (notesPath || sessionId || name), not raw sessionId
let activeTab = 'running'

// "Recent · unmanaged" section state. Discovery is lazy (on first expand) and NEVER
// runs on the 5s poll — renderUnmanagedSection is called only from expand / refresh /
// tab-switch / view-switch, so hundreds of on-disk sessions never inflate the poll.
let unmanagedState = { expanded: false, loading: false, error: '', model: null, loaded: false }

function renderUnmanagedSection() {
  const show = activeTab === 'running'
  const html = window.CSMUnmanaged.unmanagedSectionHtml(unmanagedState)
  document.querySelectorAll('.unmanaged-section, .unmanaged-slot').forEach(el => {
    el.hidden = !show
    if (show) el.innerHTML = html
  })
  // Hide standalone .unmanaged-section when a .unmanaged-slot is present (single-space running list).
  const hasSlot = document.querySelector('.unmanaged-slot')
  const standaloneSection = document.querySelector('#panel-list ~ .unmanaged-section')
  if (standaloneSection) standaloneSection.hidden = !!hasSlot || !show
}

async function loadUnmanaged() {
  unmanagedState.loading = true
  unmanagedState.error = ''
  renderUnmanagedSection()
  try {
    const sessions = await window.api.discoverSessions()
    unmanagedState.model = window.CSMUnmanaged.buildUnmanagedModel(sessions)
    unmanagedState.loaded = true
  } catch (_) {
    unmanagedState.error = 'Could not scan recent sessions.'
    unmanagedState.model = null
  }
  unmanagedState.loading = false
  renderUnmanagedSection()
}

// Re-run discovery + re-render. Exposed for Task 4 (refresh after an adopt).
window.refreshUnmanaged = function () {
  if (unmanagedState.expanded) loadUnmanaged()
  else { unmanagedState.loaded = false; unmanagedState.model = null }
}

let viewMode = 'list'    // 'list' | 'board'
let searchQuery = ''
const activeCatFilters = new Set()  // empty = show all categories
// Category order (config-driven, with fallback) is shared via renderer/lib/categories.js.
const filterCategories = () => window.CSMCategories.order()
const POLL_INTERVAL = 5000

// Root (space) names from config: v2 `roots` only. Exposed so ui.js/board.js can
// order their space sections.
function configRoots() {
  const cfg = window.CSM_CONFIG || {}
  if (Array.isArray(cfg.roots) && cfg.roots.length) {
    return cfg.roots.map(r => r && r.name).filter(Boolean)
  }
  return []
}
// More than one space configured ⇒ the list groups into space sections and the board
// shows its own space selector. A single space ⇒ no space chrome at all.
window.multiSpace = () => configRoots().length > 1
// Distinct category names for the filter popover (a name living in 2 spaces → one entry).
function rootCategoryNames() { return [...new Set(filterCategories())] }

// Active space filter — the ⚲ Filter popover's Spaces section (shown when >1 space).
// Empty = all spaces. The list also groups by space sections; the board (flat)
// relies on this filter for space scoping. window.passesSpaceFilter reads it (board).
const activeSpaceFilters = new Set()
window.passesSpaceFilter = (root) => activeSpaceFilters.size === 0 || root == null || activeSpaceFilters.has(root)

// Pinned sessions float to the top. Capped (a grid screenful) and persisted
// locally — these are app prefs, not session state, so no ~/.claude writes.
const PIN_LIMIT = 8
let pinnedKeys = new Set()
try { pinnedKeys = new Set(JSON.parse(localStorage.getItem('csm.pinnedKeys') || '[]')) } catch { /* ignore */ }

function isPinned(key) { return pinnedKeys.has(key) }
function togglePin(key) {
  if (pinnedKeys.has(key)) {
    pinnedKeys.delete(key)
  } else {
    if (pinnedKeys.size >= PIN_LIMIT) {
      const el = document.getElementById('cat-filter-list') || document.body
      el.animate?.([{ opacity: 1 }, { opacity: 0.4 }, { opacity: 1 }], { duration: 250 })
      return  // at the cap — ignore
    }
    pinnedKeys.add(key)
  }
  try { localStorage.setItem('csm.pinnedKeys', JSON.stringify([...pinnedKeys])) } catch { /* ignore */ }
  renderAll(filterSessions(sessions, searchQuery), selectedKey, activeTab, true)
}
window.isPinned = isPinned
window.togglePin = togglePin

// Appearance (theme + accent) — display prefs in localStorage (like pins; no
// ~/.claude writes). The initial load runs in an inline <head> script (no flash);
// these power the Settings controls + live apply.
function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return '126, 147, 184'
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}
window.applyTheme = (theme) => {
  const t = theme === 'light' ? 'light' : 'dark'
  document.documentElement.dataset.theme = t
  try { localStorage.setItem('csm.theme', t) } catch { /* ignore */ }
  // Keep the native window background in sync so a resize doesn't flash white (dark theme)
  // — or dark (light theme) — at the growing edge before the webview repaints.
  if (window.api && window.api.setWindowBg) window.api.setWindowBg(t === 'dark')
}
// Pick legible text (black vs white) for a solid accent-filled element, by perceived
// luminance. Lets a light accent (cyan, mauve…) keep readable CTA text without having
// to darken the accent itself — works in both themes.
function onAccentText(hex) {
  const n = parseInt(hex.slice(1), 16)
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  return lum > 150 ? '#16171b' : '#ffffff'
}
window.applyAccent = (hex) => {
  const safe = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : window.CSM_COLORS.accent
  document.documentElement.style.setProperty('--accent', safe)
  document.documentElement.style.setProperty('--accent-rgb', hexToRgbTriplet(safe))
  document.documentElement.style.setProperty('--on-accent', onAccentText(safe))
  try { localStorage.setItem('csm.accent', safe) } catch { /* ignore */ }
}
window.getTheme = () => document.documentElement.dataset.theme || 'dark'
window.getAccent = () => { try { return localStorage.getItem('csm.accent') || window.CSM_COLORS.accent } catch { return window.CSM_COLORS.accent } }

// A "look" = the accent + a faint surface tint (warm/cool ambiance) washed over the
// window background. Neutral looks pass tint '0,0,0' @ 0 (no wash). Persisted so it
// re-applies before first paint (the inline head script reads csm.lookTint/-A).
window.applyLook = (accent, tintRgb, tintA, id) => {
  window.applyAccent(accent)
  const rgb = tintRgb || '0,0,0'
  const a = String(tintA == null ? 0 : tintA)
  document.documentElement.style.setProperty('--look-tint', rgb)
  document.documentElement.style.setProperty('--look-tint-a', a)
  try {
    localStorage.setItem('csm.look', id || 'custom')
    localStorage.setItem('csm.lookTint', rgb)
    localStorage.setItem('csm.lookTintA', a)
  } catch { /* ignore */ }
}
window.getLook = () => {
  try {
    return { id: localStorage.getItem('csm.look') || 'ardoise',
             tint: localStorage.getItem('csm.lookTint') || '0,0,0',
             tintA: localStorage.getItem('csm.lookTintA') || '0' }
  } catch { return { id: 'ardoise', tint: '0,0,0', tintA: '0' } }
}

// Card density (detailed | compact | minimal): how much each list card
// shows. Applied as a data-attr on <html> so CSS hides/shows elements — no re-render
// needed (the card markup always carries every element). 'detailed' = base CSS (no attr needed).
const DENSITIES = ['detailed', 'compact', 'minimal']
window.applyDensity = (d) => {
  const v = DENSITIES.includes(d) ? d : 'detailed'
  document.documentElement.dataset.density = v
  try { localStorage.setItem('csm.density', v) } catch { /* ignore */ }
}
window.getDensity = () => { try { return localStorage.getItem('csm.density') || 'detailed' } catch { return 'detailed' } }

// Compact chrome: hide the text labels on the view switch + New button (icons only),
// for an Android-style pared-back UI. Applied as a class on <html> (so the head can
// set it pre-paint); CSS hides .btn-label under .compact-chrome.
window.applyCompactChrome = (on) => {
  document.documentElement.classList.toggle('compact-chrome', !!on)
  try { localStorage.setItem('csm.compactChrome', on ? '1' : '0') } catch { /* ignore */ }
}
window.getCompactChrome = () => { try { return localStorage.getItem('csm.compactChrome') === '1' } catch { return false } }

// Remappable keyboard shortcuts. Only the single-key "jump" actions are remappable;
// arrows / Enter / Esc stay fixed. Stored as { action: key } in localStorage.csm.keys.
const DEFAULT_KEYS = { search: '/', viewToggle: 'v', board: 'b', tabRunning: '1', tabClosed: '2', tabArchived: '3' }
window.KEY_ACTIONS = [
  { id: 'search', label: 'Focus search' },
  { id: 'viewToggle', label: 'Toggle list / board' },
  { id: 'board', label: 'Open board' },
  { id: 'tabRunning', label: 'Tab: Running' },
  { id: 'tabClosed', label: 'Tab: Closed' },
  { id: 'tabArchived', label: 'Tab: Archived' },
]
window.getKeys = () => {
  let stored = {}
  try { stored = JSON.parse(localStorage.getItem('csm.keys') || '{}') } catch { stored = {} }
  return { ...DEFAULT_KEYS, ...(stored && typeof stored === 'object' ? stored : {}) }
}
window.setKey = (action, key) => {
  if (!(action in DEFAULT_KEYS) || !key) return
  const next = { ...window.getKeys(), [action]: key }
  try { localStorage.setItem('csm.keys', JSON.stringify(next)) } catch { /* ignore */ }
}
window.setKeys = (map) => { try { localStorage.setItem('csm.keys', JSON.stringify(map || {})) } catch { /* ignore */ } }
window.resetKeys = () => { try { localStorage.removeItem('csm.keys') } catch { /* ignore */ } }

// Does a session match a free-text query across its name/ticket/category/goal/path/branch?
function matchesSearch(s, query) {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    (s.name || '').toLowerCase().includes(q) ||
    (s.ticket || '').toLowerCase().includes(q) ||
    (s.category || '').toLowerCase().includes(q) ||
    (s.goal || '').toLowerCase().includes(q) ||
    (s.cwd || '').toLowerCase().includes(q) ||
    (s.gitBranch || s.branch || '').toLowerCase().includes(q)
  )
}
function filterSessions(list, query) {
  let out = list
  if (activeSpaceFilters.size > 0) out = out.filter(s => window.passesSpaceFilter(s.root))
  if (activeCatFilters.size > 0) out = out.filter(s => activeCatFilters.has(s.category || 'OTHER'))
  if (query) out = out.filter(s => matchesSearch(s, query))
  return out
}
// Predicates exposed for the board renderer (which filters its cards directly rather
// than going through filterSessions). Empty filter / empty query = everything passes.
window.passesCatFilter = (cat) => activeCatFilters.size === 0 || activeCatFilters.has(cat || 'OTHER')
window.passesSearch = (s) => matchesSearch(s, searchQuery)
// Free-text match for arbitrary strings (board notes) against the current query.
window.queryMatches = (text) => matchesSearch({ name: text || '' }, searchQuery)

// Filter — a single "⚲ Filter" button per view bar that opens a checkbox popover
// (Spaces + Categories). Replaces the old chip row + the board space selector.
// activeCatFilters / activeSpaceFilters are the source of truth (filterSessions + board).
function renderCategoryFilters() {
  const n = activeCatFilters.size + activeSpaceFilters.size
  const btn = `<button class="filter-btn ${n ? 'active' : ''}" data-filter-open aria-label="Filter" title="Filter by space or category">⚲ <span class="btn-label">Filter</span>${n ? ` <span class="filter-count">${n}</span>` : ''}</button>`
  // ＋Import sits on the left of the list's filter row: the entry point for adopting a
  // session by id, or browsing every session the dashboard isn't tracking (the inline
  // "Recent · unmanaged" section only shows the newest few). Board keeps the filter alone.
  const importBtn = `<button class="import-btn" data-import-open title="Adopt a session by ID, or browse every untracked session">＋ <span class="btn-label">Import</span></button>`
  const listEl = document.getElementById('cat-filter-list')
  if (listEl) listEl.innerHTML = importBtn + btn
  const boardEl = document.getElementById('cat-filter-board')
  if (boardEl) boardEl.innerHTML = btn
}

function closeFilterMenu() {
  const m = document.getElementById('filter-menu')
  if (m) m.remove()
  document.removeEventListener('mousedown', onFilterOutside, true)
  document.removeEventListener('keydown', onFilterEsc, true)
}
function onFilterOutside(e) {
  if (!e.target.closest('#filter-menu') && !e.target.closest('[data-filter-open]')) closeFilterMenu()
}
function onFilterEsc(e) { if (e.key === 'Escape') { e.preventDefault(); closeFilterMenu() } }

// Build the filter popover anchored under the clicked button. A Spaces section (when
// >1 space) + a Categories section (deduped — a name in 2 spaces → one row). Toggling
// updates activeSpaceFilters / activeCatFilters live.
function openFilterMenu(anchor) {
  if (document.getElementById('filter-menu')) { closeFilterMenu(); return }
  const opt = (on, attr, label) =>
    `<button class="filter-opt ${on ? 'on' : ''}" ${attr}><span class="filter-box"></span><span class="filter-opt-name">${label}</span></button>`
  let spaceSection = ''
  if (window.multiSpace && window.multiSpace()) {
    const spaceRows = configRoots()
      .map(sp => opt(activeSpaceFilters.has(sp), `data-filter-space="${escapeAttr(sp)}"`, sp)).join('')
    spaceSection = `<div class="filter-menu-head">Spaces</div><div class="filter-menu-list">${spaceRows}</div>`
  }
  const catRows = rootCategoryNames()
    .map(cat => opt(activeCatFilters.has(cat), `data-filter-cat="${escapeAttr(cat)}"`, cat)).join('')
  const total = activeCatFilters.size + activeSpaceFilters.size
  const clear = total
    ? `<button class="filter-opt filter-clear" data-filter-clear>Clear (${total})</button>` : ''
  const menu = document.createElement('div')
  menu.id = 'filter-menu'
  menu.className = 'filter-menu'
  menu.innerHTML = `${spaceSection}<div class="filter-menu-head">Categories</div><div class="filter-menu-list">${catRows}</div>${clear}`
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  menu.style.top = `${Math.round(r.bottom + 4)}px`
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)))}px`
  setTimeout(() => {
    document.addEventListener('mousedown', onFilterOutside, true)
    document.addEventListener('keydown', onFilterEsc, true)
  }, 0)
}
// Minimal attribute escaper (category names are validated tokens, but be safe).
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;') }

// +New: the selected space (a config root name). Both the category list AND the space
// the session launches under derive from it.
let nsRoot = ''
// Distinct category names that live in a given space.
function categoriesForRoot(rootName) {
  const cats = (window.CSM_CONFIG && window.CSM_CONFIG.categories) || []
  const names = cats
    .filter(c => c.root === rootName)
    .map(c => c.name)
  return names.length ? [...new Set(names)] : filterCategories()
}

// Fill the +New modal's category dropdown from config (validated names, so safe to
// interpolate). Shows the Space <select> only when >1 space exists, and filters the
// categories to the selected space.
function populateNewSessionCategories() {
  const sel = document.getElementById('ns-category')
  if (!sel) return
  const spaces = configRoots()
  const multi = spaces.length > 1
  const field = document.getElementById('ns-space-field')
  const spaceSel = document.getElementById('ns-space')
  if (field) field.hidden = !multi
  if (multi && spaceSel) {
    if (!spaces.includes(nsRoot)) nsRoot = spaces[0]
    spaceSel.innerHTML = spaces.map(s => `<option value="${s}">${s}</option>`).join('')
    spaceSel.value = nsRoot
  }
  const list = multi ? categoriesForRoot(nsRoot) : filterCategories()
  sel.innerHTML = list.map(cat => `<option value="${cat}">${cat}</option>`).join('')
  syncPrField()   // selected category may have changed → toggle the PR field
}

function applyFilterChange() {
  selectedKey = null
  window._lastSelectedKey = null
  renderCategoryFilters()
  if (viewMode === 'board') { if (window.renderBoard) window.renderBoard() }
  else renderAll(filterSessions(sessions, searchQuery), selectedKey, activeTab, true)
}
function toggleCategoryFilter(cat) {
  if (activeCatFilters.has(cat)) activeCatFilters.delete(cat); else activeCatFilters.add(cat)
  applyFilterChange()
}
function toggleSpaceFilter(space) {
  if (activeSpaceFilters.has(space)) activeSpaceFilters.delete(space); else activeSpaceFilters.add(space)
  applyFilterChange()
}

let fetchInFlight = false
async function fetchAndRender(resort = false) {
  fetchInFlight = true
  // Capture the tab this fetch is FOR. switchTab() flips activeTab and fires its own
  // fetch without waiting for an in-flight one, so activeTab can change during the
  // awaits below. Keying everything off `tab` (not the live activeTab) keeps this
  // fetch self-consistent, and we bail before clobbering shared state if the user has
  // since moved on.
  const tab = activeTab
  try {
    let fetched
    if (tab === 'running') {
      // Running = active (live pid) ∪ stale (terminal gone, not /closed yet).
      const [active, stale] = await Promise.all([
        window.api.getSessions(),
        window.api.getHistoricalSessions('stale'),
      ])
      fetched = [...active, ...stale]
    } else {
      fetched = await window.api.getHistoricalSessions(tab)
    }
    // Per-tab badge count — keyed by the fetched tab, so it's valid to record even if
    // we've since switched away (current tab updates each poll; others fill on visit).
    window._tabCounts = window._tabCounts || {}
    window._tabCounts[tab] = fetched.length
    // Stale result: the user switched tabs mid-flight (their switch started its own
    // fetch). This data is for a tab that's no longer showing — don't paint it over the
    // current view or clobber the shared session list.
    if (tab !== activeTab) return
    sessions = fetched
    window._lastSessions = sessions
    window._lastSelectedKey = selectedKey
    window._sessionsLoaded = true   // first fetch done → empty list shows "empty", not "Loading…"
    if (tab === 'running') window._waitingCount = sessions.filter(s => s.status === 'waiting').length
    // Prune list-org of sessions no longer present (moved to Closed/Archived, etc.).
    // Only prune on the Running tab — manual order/groups apply to the running list;
    // pruning on other tabs would drop running keys not present in those tabs' session sets.
    if (tab === 'running') {
      const liveByCat = {}
      for (const s of sessions) { const c = s.category || (s.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'OTHER'); (liveByCat[c] = liveByCat[c] || new Set()).add(s.notesPath || s.sessionId || s.name || '') }
      window.CSMListOrg.save(window.CSMListOrg.prune(window.CSMListOrg.load(), liveByCat))
    }
    renderAll(filterSessions(sessions, searchQuery), selectedKey, tab, resort)
  } catch (err) {
    console.error('Failed to fetch sessions:', err)
  } finally {
    fetchInFlight = false
  }
}

// Open a session's detail in the slide-over drawer WITHOUT leaving the board (UX:
// the board is the cockpit — see + act in context instead of redirecting to the list).
window.openBoardDetail = (key) => {
  const s = (window._boardIndex || {})[key]
  if (!s) return
  selectedKey = key
  window._lastSelectedKey = key
  const tab = (s.state === 'closed' || s.state === 'archived') ? s.state : 'running'
  if (window.renderDetailPanel) window.renderDetailPanel(s, tab)
  document.getElementById('panel-detail').classList.add('open')
  document.getElementById('scrim').classList.add('open')
  if (window.refreshUsage) window.refreshUsage()
}

// The board is GLOBAL — it resolves placed sessions across all states. Cache the
// combined lists by sessionKey so board cards render without per-card fetches.
window._boardIndex = {}
async function buildBoardIndex() {
  try {
    const [running, hist] = await Promise.all([
      window.api.getSessions(),
      window.api.getHistoricalAll(),   // {stale, closed, archived} in one scan
    ])
    const idx = {}
    for (const s of [...running, ...hist.stale, ...hist.closed, ...hist.archived]) idx[sessionKey(s)] = s
    window._boardIndex = idx
  } catch (err) { console.error('board index fetch failed:', err) }
}
window.refreshBoard = async () => {
  await buildBoardIndex()
  if (viewMode === 'board' && window.renderBoard) window.renderBoard()
}

function selectSession(key) {
  const changing = key !== selectedKey
  selectedKey = key === selectedKey ? null : key
  window._lastSelectedKey = selectedKey
  // Switching sessions must NOT kill the embedded terminal — keep the pty alive
  // so sessions run in parallel. If the newly selected session already has a live
  // terminal, reveal it; otherwise just hide the pane (the previous pty keeps
  // running in the background). Only "Close session ✕" kills.
  if (changing) {
    const sel = selectedKey && sessions.find(s => sessionKey(s) === selectedKey)
    // A session has at most one live embedded pty. liveTerminalKeyFor finds it by notes.md
    // (stable across resume sid-changes) then by sessionId — so a backgrounded terminal is
    // re-revealed whether it was a +New (notesPath key) or a resumed one (older sid key).
    const tkey = sel && window.liveTerminalKeyFor ? window.liveTerminalKeyFor(sel.sessionId, sel.notesPath) : null
    if (tkey) {
      window.openTerminalPane(tkey, sel.cwd || '')
    } else if (window.getTerminalVisible && window.getTerminalVisible()) {
      window.hideTerminalPane()
    }
  }
  // resort=false → selecting must never reorder the list under the cursor
  renderAll(filterSessions(sessions, searchQuery), selectedKey, activeTab, false)
  if (window.refreshUsage) window.refreshUsage()
}

// From the board → reveal a session in the List view: switch to its tab (Running /
// Closed / Archived), load it, then select + scroll to it. The tab is inferred from
// the session shape (running sessions carry a live `status`; historical ones a
// `historyStatus`).
window.goToSession = async (key) => {
  const s = (window._boardIndex || {})[key]
  if (!s) return
  // active + stale both live in the Running tab; closed/archived in their own.
  const tab = (s.state === 'closed' || s.state === 'archived') ? s.state : 'running'
  if (activeTab !== tab) {
    activeTab = tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab))
    await fetchAndRender(true)
  }
  setViewMode('list')
  selectedKey = null   // selectSession toggles — clear first so this always selects
  selectSession(key)
  const el = document.querySelector(`.list-card[data-key="${CSS.escape(key)}"]`)
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function switchTab(tab) {
  activeTab = tab
  selectedKey = null
  window._lastSelectedKey = null
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab)
  })
  fetchAndRender(true)  // tab switch → fresh sort
  renderUnmanagedSection()
}

function cycleTab(dir) {
  const tabs = ['running', 'closed', 'archived']
  const i = tabs.indexOf(activeTab)
  switchTab(tabs[(i + dir + tabs.length) % tabs.length])
}

// Re-reveal a backgrounded embedded terminal for the still-selected session — used
// when arriving at the List view (e.g. from Board, which hides the terminal pane).
// Idempotent: bails if a terminal is already showing or nothing live is selected.
function restoreTerminalForSelected() {
  if (window.getTerminalVisible && window.getTerminalVisible()) return
  if (!selectedKey) return
  const sel = sessions.find(s => sessionKey(s) === selectedKey)
  if (!sel || !window.openTerminalPane) return
  // Find the live terminal by notes.md (stable across resume sid-changes) then sessionId.
  const tkey = window.liveTerminalKeyFor ? window.liveTerminalKeyFor(sel.sessionId, sel.notesPath) : null
  if (tkey) window.openTerminalPane(tkey, sel.cwd || '')
}

function setViewMode(mode) {
  const prevMode = viewMode
  viewMode = mode
  window.viewMode = mode   // exposed for settings.js (refresh board after column edits)
  document.body.classList.toggle('mode-list', mode === 'list')
  document.body.classList.toggle('mode-board', mode === 'board')
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === mode)
  })
  if (mode === 'board') {
    // Board is global; the terminal pane belongs to the detail panel (hidden here).
    if (window.getTerminalVisible && window.getTerminalVisible()) window.hideTerminalPane()
    const bs = document.getElementById('board-search')   // reflect any active search
    if (bs && bs.value !== searchQuery) bs.value = searchQuery
    if (window.renderBoard) window.renderBoard()     // columns now (don't wait on the fetch)
    if (window.refreshBoard) window.refreshBoard()   // then refresh card data from sessions
    return
  }
  renderAll(filterSessions(sessions, searchQuery), selectedKey, activeTab, false)
  // Arriving at List from another view (Board hides the terminal pane on the way
  // out) → bring the selected session's live terminal back into view.
  if (mode === 'list' && prevMode !== 'list') restoreTerminalForSelected()
  renderUnmanagedSection()
}

// Close the board's slide-over drawer
function closeDrawer() {
  // Dismissing the drawer only hides the terminal (pty stays alive); "Close session ✕" kills.
  if (window.getTerminalVisible && window.getTerminalVisible()) window.hideTerminalPane()
  selectedKey = null
  window._lastSelectedKey = null
  renderAll(filterSessions(sessions, searchQuery), selectedKey, activeTab, false)
}

// Search — both fields (sidebar + board filterbar) drive the same query
const SEARCH_FIELD_IDS = ['search-field', 'board-search']
function onSearchInput(e) {
  searchQuery = e.target.value.trim()
  selectedKey = null
  // keep both search fields (list / board) in sync
  for (const id of SEARCH_FIELD_IDS) {
    const el = document.getElementById(id)
    if (el && el !== e.target && el.value !== e.target.value) el.value = e.target.value
  }
  if (viewMode === 'board') { if (window.renderBoard) window.renderBoard() }
  else renderAll(filterSessions(sessions, searchQuery), selectedKey, activeTab, true)
}
SEARCH_FIELD_IDS.forEach(id => {
  const el = document.getElementById(id)
  if (el) el.addEventListener('input', onSearchInput)
})

// Delegated click handler for unmanaged section controls
document.body.addEventListener('click', (e) => {
  // Toggle expand/collapse (ignore clicks on the refresh button inside the header).
  const toggle = e.target.closest('[data-unmanaged-toggle]')
  if (toggle && !e.target.closest('[data-unmanaged-refresh]')) {
    unmanagedState.expanded = !unmanagedState.expanded
    if (unmanagedState.expanded && !unmanagedState.loaded && !unmanagedState.loading) loadUnmanaged()
    else renderUnmanagedSection()
    return
  }
  // Refresh / retry (rescan).
  if (e.target.closest('[data-unmanaged-refresh]')) {
    e.stopPropagation()
    unmanagedState.expanded = true
    loadUnmanaged()
    return
  }
  // Adopt a row (open the Import modal preselected with that session).
  const adopt = e.target.closest('[data-adopt-sid]')
  if (!adopt) return
  openImportModal({
    preselectSessionId: adopt.dataset.adoptSid,
    defaultName: adopt.dataset.adoptName || '',
    targetLabel: adopt.dataset.adoptTitle || adopt.dataset.adoptName || '',
  })
})

document.body.addEventListener('click', (e) => {
  const chev = e.target.closest('[data-group-collapse]')
  if (chev) {
    const head = chev.closest('.list-group-head')
    window.CSMListOrg.save(window.CSMListOrg.toggleGroupCollapsed(window.CSMListOrg.load(), head.dataset.cat, head.dataset.group))
    fetchAndRender(false)
    return
  }
  const del = e.target.closest('[data-group-delete]')
  if (del) {
    const head = del.closest('.list-group-head')
    window.CSMListOrg.save(window.CSMListOrg.deleteGroup(window.CSMListOrg.load(), head.dataset.cat, head.dataset.group))
    fetchAndRender(false)
    return
  }
})

document.body.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-group-rename]')
  if (!trigger) return
  const head = trigger.closest('.list-group-head')
  if (!head) return
  const nameEl = head.querySelector('.list-group-name')
  if (!nameEl || head.querySelector('.list-group-name-input')) return   // no name, or already editing
  const cat = head.dataset.cat, gid = head.dataset.group
  const input = document.createElement('input')
  input.className = 'list-group-name-input'
  input.value = nameEl.textContent.trim()
  nameEl.replaceWith(input)
  window._listEditing = true
  input.focus(); input.select()
  let settled = false
  const settle = (commit) => {
    if (settled) return; settled = true
    window._listEditing = false
    if (document.activeElement === input) input.blur()
    if (commit) {
      const v = input.value.trim()
      if (v) window.CSMListOrg.save(window.CSMListOrg.renameGroup(window.CSMListOrg.load(), cat, gid, v))
    }
    fetchAndRender(false)   // repaint (commit persisted, or revert on cancel)
  }
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); settle(true) }
    else if (ev.key === 'Escape') { ev.preventDefault(); settle(false) }
  })
  input.addEventListener('blur', () => settle(true))
})

// When an embedded terminal opens, it resumes the session — which makes a Closed
// session live. Remember the session (so renderAll keeps its panel + terminal
// alive across the Closed→Running migration) and flip the view to the Running tab,
// keeping the session selected. The selection key (notesPath) is stable across
// tabs, so once the resumed session registers in the running list it stays current.
window.onTerminalOpened = (key) => {
  // `key` is a sessionId (Resume/Restart) or a notesPath (embedded +New). Match either —
  // for a brand-new +New session not yet in the list, s is undefined and the synthetic
  // _terminalSession seeded at submit stays put until the poll discovers the real one.
  const s = sessions.find(x => x.sessionId === key || sessionKey(x) === key)
  if (s) window._terminalSession = s
  // Select the session regardless of which tab we're already on — this used to happen
  // only in the tab-switch branch below, so opening a terminal FROM the Running tab (the
  // common case: click Resume while already there) never highlighted anything. You'd end
  // up inside a session with no card marked as the one you're in.
  if (s) { selectedKey = sessionKey(s); window._lastSelectedKey = selectedKey }
  if (activeTab !== 'running') {
    activeTab = 'running'
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === 'running')
    })
    fetchAndRender(true)
  } else {
    // Already on the running tab — re-render so the header picks up the icons
    // now that the terminal is visible, and the newly-selected card highlights.
    renderAll(filterSessions(sessions, searchQuery), selectedKey, activeTab, false)
  }
}
window.onTerminalClosed = () => {
  window._terminalSession = null
  // Terminal hidden → header drops its icons, info pane shows the full Actions row.
  renderAll(filterSessions(sessions, searchQuery), selectedKey, activeTab, false)
}

// True if this session's claude process is currently live. On the Running tab
// every listed session is alive (get_sessions filters by alive pid); live sessions
// never appear on Closed/Archived. So "running tab + in the list" == live.
// Live = an ACTIVE running process. The Running tab now also lists stale sessions
// (dead pid, not /closed); those must NOT count as live or opening one wrongly warns
// "already running".
window.isSessionLive = (sid) =>
  activeTab === 'running' && !!sid && sessions.some(s => s.sessionId === sid && s.state === 'active')

window.sessionNameFor = (sid) => {
  const s = (window._lastSessions || []).find(x => x.sessionId === sid)
  return (s && s.name) || 'This session'
}
window.sessionPidFor = (sid) => {
  const s = (window._lastSessions || []).find(x => x.sessionId === sid)
  return (s && s.pid) || 0
}

// Sticky open destination (Embedded vs external Terminal), shared by Resume/Restart.
// localStorage like the other appearance prefs → folds into durable storage (#18).
window.getOpenIn = () => (localStorage.getItem('csm.openIn') === 'terminal' ? 'terminal' : 'embedded')
window.setOpenIn = (v) => localStorage.setItem('csm.openIn', v === 'terminal' ? 'terminal' : 'embedded')

// Promise-based confirm dialog. Resolves 'confirm' | 'extra' | 'cancel'. The
// optional extra button (extraLabel) sits between Cancel and the primary action.
window.confirmAction = ({ title = 'Heads up', body = '', confirmLabel = 'Continue', extraLabel = null } = {}) =>
  new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal')
    document.getElementById('confirm-title').textContent = title
    document.getElementById('confirm-body').textContent = body
    const okBtn = document.getElementById('confirm-ok')
    const cancelBtn = document.getElementById('confirm-cancel')
    const extraBtn = document.getElementById('confirm-extra')
    okBtn.textContent = confirmLabel
    if (extraLabel) { extraBtn.textContent = extraLabel; extraBtn.hidden = false } else { extraBtn.hidden = true }
    const done = (val) => {
      okBtn.removeEventListener('click', onOk)
      cancelBtn.removeEventListener('click', onCancel)
      extraBtn.removeEventListener('click', onExtra)
      modal.removeEventListener('cancel', onEsc)
      modal.close()
      resolve(val)
    }
    const onOk = () => done('confirm')
    const onCancel = () => done('cancel')
    const onExtra = () => done('extra')
    const onEsc = () => done('cancel') // Esc key
    okBtn.addEventListener('click', onOk)
    cancelBtn.addEventListener('click', onCancel)
    extraBtn.addEventListener('click', onExtra)
    modal.addEventListener('cancel', onEsc)
    modal.showModal()
  })

// Re-fetch + re-render the current tab (e.g. after archiving moves a session out).
window.refreshSessions = () => fetchAndRender(true)

window.selectSession = selectSession
window.switchTab = switchTab
window.closeDrawer = closeDrawer
window.detachSession = (key) => {
  window.api.detachSession(key)
  closeDrawer()  // close the in-app drawer once it pops out to its own window
}

// View toggle buttons — only the titlebar ones (data-view). The theme/scope
// toggles reuse .view-btn but have their own handlers; don't wire setViewMode to them.
document.querySelectorAll('.view-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => setViewMode(btn.dataset.view))
})

// New-session backoffice
const newSessionModal = document.getElementById('new-session-modal')
const nsError = document.getElementById('ns-error')
function showNsError(msg) { nsError.textContent = msg; nsError.hidden = false }
function hideNsError() { nsError.hidden = true; nsError.textContent = '' }

// GitHub PR URL — mirrors is_pr_url in lib.rs (Rust re-validates; this is fast UX).
const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+([/#?].*)?$/
function isPrUrl(u) { return PR_URL_RE.test(u) }
// The "PR to review" field is REVIEW-only — show it only for that category.
function syncPrField() {
  const cat = document.getElementById('ns-category')
  const field = document.getElementById('ns-pr-field')
  if (cat && field) field.hidden = cat.value !== 'REVIEW'
}

document.getElementById('new-session-btn').addEventListener('click', () => {
  for (const id of ['ns-name', 'ns-ticket', 'ns-repo', 'ns-branch', 'ns-pr']) {
    document.getElementById(id).value = ''
  }
  hideNsError()
  populateNewSessionCategories()   // refresh (scope toggle + config may have changed)
  // Render the Embedded/Terminal destination toggle reflecting the current pref.
  const destEl = document.getElementById('ns-dest')
  if (destEl && window.destinationToggle) destEl.innerHTML = window.destinationToggle()
  newSessionModal.showModal()
  document.getElementById('ns-name').focus()
})
document.getElementById('ns-cancel').addEventListener('click', () => newSessionModal.close())
// Category change → show/hide the REVIEW-only PR field.
document.getElementById('ns-category').addEventListener('change', syncPrField)

// Space select: switch space → re-filter the category dropdown.
{
  const spaceSel = document.getElementById('ns-space')
  if (spaceSel) spaceSel.addEventListener('change', () => {
    nsRoot = spaceSel.value
    populateNewSessionCategories()
  })
}

// Browse → native folder picker for the optional repo field (untouched on cancel).
newSessionModal.addEventListener('click', async (e) => {
  const browse = e.target.closest('.path-browse[data-browse]')
  if (!browse) return
  const target = document.getElementById(browse.dataset.browse)
  if (!target || !window.api.pickDirectory) return
  const picked = await window.api.pickDirectory()
  if (picked) target.value = picked
})

// ── ＋Import: adopt an existing (unmanaged) Claude Code session ──
const importModal = document.getElementById('import-modal')
let importSelectedSid = null
let importSessions = []
let importRoot = ''   // the chosen space (config root name); '' until populated
// Populate the category dropdown — filtered by the chosen space when >1 exists (mirrors
// +New's populateNewSessionCategories). Shows the Space <select> only then. UNNAMED fallback.
function populateImportCategories() {
  const spaces = configRoots()
  const multi = spaces.length > 1
  const field = document.getElementById('import-space-field')
  const spaceSel = document.getElementById('import-space')
  if (field) field.hidden = !multi
  if (multi && spaceSel) {
    if (!spaces.includes(importRoot)) importRoot = spaces[0]
    spaceSel.innerHTML = spaces.map(s => `<option value="${importEsc(s)}">${importEsc(s)}</option>`).join('')
    spaceSel.value = importRoot
  } else {
    importRoot = ''
  }
  let cats = multi ? categoriesForRoot(importRoot) : filterCategories()
  if (!cats.length) cats = ['UNNAMED']
  document.getElementById('import-category').innerHTML = cats.map(c => `<option value="${importEsc(c)}">${importEsc(c)}</option>`).join('')
}
const importEsc = (s) => (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const showImportError = (m) => { const el = document.getElementById('import-error'); el.textContent = m; el.hidden = false }
const hideImportError = () => { document.getElementById('import-error').hidden = true }
// A pasted session ID (overrides the list selection). Light format check; the backend
// validates for real. Returns '' when the field is empty or malformed.
function importValidUid() {
  const u = (document.getElementById('import-uid').value || '').trim()
  return /^[A-Za-z0-9_-]+$/.test(u) ? u : ''
}
// Import is enabled when there's an effective session id — a pasted UID OR a selected row.
function updateImportGo() {
  document.getElementById('import-go').disabled = !(importValidUid() || importSelectedSid)
}
function renderImportList(query) {
  const list = document.getElementById('import-list')
  const q = (query || '').toLowerCase()
  const rows = importSessions.filter(s => !q ||
    (s.title || '').toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q) || (s.sessionId || '').toLowerCase().includes(q))
  if (!rows.length) {
    list.innerHTML = `<div class="import-empty">${importSessions.length ? 'No match.' : 'No unmanaged sessions found.'}</div>`
    return
  }
  list.innerHTML = rows.map(s => {
    const when = s.mtime ? formatTimestamp(new Date(s.mtime * 1000).toISOString()) : ''
    const title = importEsc(s.title || '(untitled session)')
    const cwd = importEsc(s.cwd || '')
    // Full title + path in the native tooltip — the rows are ellipsis-truncated.
    const tip = `${title}${cwd ? `\n${cwd}` : ''}`
    return `<button type="button" class="import-row${s.sessionId === importSelectedSid ? ' selected' : ''}" data-import-sid="${importEsc(s.sessionId)}" data-title="${title}" title="${tip}">
      <span class="import-row-title">${title}</span>
      <span class="import-row-meta">${cwd}${when ? ' · ' + when : ''}</span>
    </button>`
  }).join('')
}
// How many sessions one "page" of the browse list holds, and where we are in it.
const IMPORT_PAGE = 20
let importOffset = 0
let importTotal = 0

// Two modes:
//  • Adopt on a row  → the session is already chosen. No picker, no id field: the modal
//    only asks where it should land. Showing a list there would invite adopting a
//    DIFFERENT session than the one clicked.
//  • ＋Import        → nothing chosen yet: search + page through every untracked session,
//    or paste an id for one that isn't listed.
async function openImportModal(opts) {
  const preselectSessionId = opts && opts.preselectSessionId
  const defaultName = (opts && opts.defaultName) || ''
  const single = !!preselectSessionId
  importSelectedSid = preselectSessionId || null
  importSessions = []
  importOffset = 0
  importTotal = 0
  document.getElementById('import-uid').value = ''
  document.getElementById('import-search').value = ''
  document.getElementById('import-name').value = defaultName
  hideImportError()
  populateImportCategories()
  // Render the Embedded/Terminal destination toggle reflecting the current pref (like +New).
  const destEl = document.getElementById('import-dest')
  if (destEl && window.destinationToggle) destEl.innerHTML = window.destinationToggle()

  const browse = document.getElementById('import-browse')
  const target = document.getElementById('import-target')
  const title = document.getElementById('import-title')
  const hint = document.getElementById('import-hint')
  if (browse) browse.hidden = single
  if (target) {
    target.hidden = !single
    if (single) {
      const label = (opts && opts.targetLabel) || defaultName || preselectSessionId
      target.innerHTML = `<span class="import-target-label">Adopting</span> <span class="import-target-name">${importEsc(label)}</span>`
    }
  }
  if (title) title.textContent = single ? 'Adopt this session' : 'Import a session'
  if (hint) {
    hint.textContent = single
      ? "It resumes and gets a notes.md, so it shows up like any managed session. Choose where it lands."
      : "Adopt a session the dashboard isn't tracking yet. Search the list, or paste an id."
  }

  document.getElementById('import-go').disabled = !importSelectedSid
  importModal.showModal()
  if (!single) {
    document.getElementById('import-list').innerHTML = '<div class="import-empty">Loading…</div>'
    await loadImportPage(true)
  }
  updateImportGo()
}

// Fetch one page of untracked sessions, appending unless `reset`. `total` comes back with
// the page so "Load more" only shows while there is genuinely more to fetch.
async function loadImportPage(reset) {
  if (reset) { importSessions = []; importOffset = 0 }
  const res = await window.api.discoverSessionsPage(IMPORT_PAGE, importOffset)
  if (res && res.ok === false) {
    // Say so rather than leaving a button that appears to do nothing.
    showImportError(`Could not list sessions: ${res.error}`)
    const more = document.getElementById('import-more')
    if (more) more.hidden = true
    return
  }
  const page = (res && res.sessions) || []
  importTotal = (res && res.total) || 0
  importSessions = importSessions.concat(page)
  importOffset += page.length
  renderImportList(document.getElementById('import-search').value || '')
  const more = document.getElementById('import-more')
  if (more) more.hidden = importSessions.length >= importTotal
}

document.body.addEventListener('click', (e) => {
  if (e.target.closest('[data-import-open]')) openImportModal()
})
document.getElementById('import-more').addEventListener('click', () => loadImportPage(false))
document.getElementById('import-cancel').addEventListener('click', () => importModal.close())
// Escape closes the modal. The search field is type=search, which natively eats
// Escape (to clear itself) before the dialog's own cancel — so close it explicitly.
importModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); importModal.close() } })
// Space select → re-filter the category dropdown (mirrors +New).
{
  const spaceSel = document.getElementById('import-space')
  if (spaceSel) spaceSel.addEventListener('change', () => {
    importRoot = spaceSel.value
    populateImportCategories()
  })
}
// Paste-a-session-ID field: a valid id enables Import even with no row selected (and
// wins over the row when both are set — see the Import handler).
document.getElementById('import-uid').addEventListener('input', () => { hideImportError(); updateImportGo() })
document.getElementById('import-search').addEventListener('input', e => renderImportList(e.target.value))
document.getElementById('import-list').addEventListener('click', (e) => {
  const row = e.target.closest('[data-import-sid]')
  if (!row) return
  importSelectedSid = row.dataset.importSid
  document.querySelectorAll('#import-list .import-row.selected').forEach(r => r.classList.remove('selected'))
  row.classList.add('selected')
  const nameEl = document.getElementById('import-name')
  if (!nameEl.value.trim()) nameEl.value = (row.dataset.title || '').replace(/^\(untitled session\)$/, '').slice(0, 60)
  hideImportError()
  updateImportGo()
})
document.getElementById('import-go').addEventListener('click', async () => {
  const sid = importValidUid() || importSelectedSid   // pasted ID wins over the selected row
  if (!sid) return
  const category = document.getElementById('import-category').value
  const name = document.getElementById('import-name').value.trim()
  // The space to import under: the chosen one (multi-space) else the only space.
  const spaces = configRoots()
  const space = spaces.length > 1 ? importRoot : (spaces[0] || '')
  const embedded = !!(window.getOpenIn && window.getOpenIn() === 'embedded')
  const goBtn = document.getElementById('import-go')
  goBtn.disabled = true
  // If the chosen category doesn't exist yet (the UNNAMED fallback, or a one-off),
  // create it in the config first so the backend recognises it + scans its folder.
  const cfg = window.CSM_CONFIG || {}
  const existing = cfg.categories || []
  if (!existing.some(c => c.name === category)) {
    const newCat = { name: category, color: window.CSM_COLORS.neutral }
    if (space) newCat.root = space
    const next = { ...cfg, categories: [...existing, newCat] }
    const w = await window.api.setConfig(next)
    if (!w || !w.ok) { showImportError((w && w.error) || 'Could not create the category.'); goBtn.disabled = false; return }
    if (window.reloadConfig) await window.reloadConfig()
  }
  const res = await window.api.importSession(sid, category, name, space, embedded)
  if (!res || !res.ok) { showImportError((res && res.error) || 'Import failed.'); goBtn.disabled = false; return }
  importModal.close()
  if (window.refreshUnmanaged) window.refreshUnmanaged()
  if (embedded && res.command && window.openTerminalPane) {
    // Adopt in the embedded terminal, keyed by the session's REAL id (already known). When
    // /import-session registers it, the card carries this sessionId → it reveals THIS pty
    // (the normal sessionId reveal), no re-key. The synthetic keeps the panel alive until
    // the poll discovers the real session (renderAll re-resolves by sessionId).
    window._terminalSession = {
      sessionId: sid, name, category, cwd: '', status: 'busy', state: 'active',
      notesPath: '', ticket: '', prLink: '', branch: '', gitBranch: '',
      goal: '', lastActivity: '', lastActivityAt: '', updatedAt: '', startedAt: '', nextSteps: '',
    }
    selectedKey = sid
    window._lastSelectedKey = sid
    if (window.setViewMode && window.viewMode !== 'list') window.setViewMode('list')   // embedded lives in List
    window.openTerminalPane(sid, '', '', res.command)
  } else if (activeTab !== 'running') {
    // External terminal: it resumes + becomes managed → shows up in Running on the next poll.
    switchTab('running')
  }
})

// Submit: validate, start (Rust pre-flights repo/branch), and ONLY close on
// success — failures (bad branch/repo) surface inline since the iTerm tab can't.
document.getElementById('new-session-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  hideNsError()
  const category = document.getElementById('ns-category').value
  const name = document.getElementById('ns-name').value.trim()
  const ticket = document.getElementById('ns-ticket').value.trim()
  const repo = document.getElementById('ns-repo').value.trim()
  const branch = document.getElementById('ns-branch').value.trim()
  const prLink = category === 'REVIEW' ? document.getElementById('ns-pr').value.trim() : ''
  if (!name) { showNsError('Title is required.'); return }
  if (branch && !repo) { showNsError('Pick a repo for the branch to be checked out in.'); return }
  if (prLink && !isPrUrl(prLink)) { showNsError('PR link must be a GitHub PR URL (…/owner/repo/pull/123).'); return }
  // Space the session launches under — only meaningful when >1 space (the picker is
  // shown); empty otherwise, in which case start_session uses the category's own root.
  const root = (configRoots().length > 1) ? nsRoot : ''
  // Destination: shared sticky pref (csm.openIn, same toggle as Resume/Restart). NOTE the
  // pref defaults to 'embedded', so +New now defaults to the in-app terminal — a change
  // from its historical always-iTerm behaviour. The modal toggle shows the current pick.
  // 'terminal' = external iTerm tab (the old behaviour).
  const embedded = !!(window.getOpenIn && window.getOpenIn() === 'embedded')
  const res = await window.api.startSession({ category, name, ticket, repo, branch, prLink, root, embedded })
  if (!res || !res.ok) {
    showNsError('Could not start: ' + ((res && res.error) || 'unknown error'))
    return
  }
  newSessionModal.close()
  if (embedded && res.command && res.notesPath && window.openTerminalPane) {
    // Run it in the embedded terminal, keyed by the notesPath the skill WILL create — which
    // is the session's eventual sessionKey, so when the poll discovers it the card links to
    // this same pty (no re-key; pty_spawn's guard blocks a double-client). Seed a synthetic
    // _terminalSession so the panel survives until renderAll re-resolves it by key (notesPath).
    window._terminalSession = {
      notesPath: res.notesPath, name, category, root,
      cwd: '', status: 'busy', state: 'active',
      // safe-empty defaults: the synthetic feeds renderDetailPanel (which fills the visible
      // header) until the ~5s poll discovers the real session and renderAll re-resolves it
      // by key — so no field deref can throw in the gap.
      sessionId: '', ticket: '', prLink: '', branch: '', gitBranch: '',
      goal: '', lastActivity: '', lastActivityAt: '', updatedAt: '', startedAt: '', nextSteps: '',
    }
    if (window.setViewMode && window.viewMode !== 'list') window.setViewMode('list')   // embedded lives in List
    selectedKey = res.notesPath
    window._lastSelectedKey = res.notesPath
    // openTerminalPane → onTerminalOpened flips to the Running tab WITHOUT nulling the
    // selection (switchTab() would reset selectedKey, collapsing the panel — bug fixed).
    window.openTerminalPane(res.notesPath, '', '', res.command, res.notesPath)
  }
})

// Filter popover (delegated): open button, per-space + per-category toggle, clear-all.
document.addEventListener('click', e => {
  const open = e.target.closest('[data-filter-open]')
  if (open) { e.stopPropagation(); openFilterMenu(open); return }
  const sp = e.target.closest('[data-filter-space]')
  if (sp) { toggleSpaceFilter(sp.dataset.filterSpace); sp.classList.toggle('on'); return }
  const opt = e.target.closest('[data-filter-cat]')
  if (opt) { toggleCategoryFilter(opt.dataset.filterCat); opt.classList.toggle('on'); return }
  const clear = e.target.closest('[data-filter-clear]')
  if (clear) {
    activeCatFilters.clear(); activeSpaceFilters.clear()
    applyFilterChange(); closeFilterMenu()
  }
})

// Scrim click closes the drawer
document.getElementById('scrim').addEventListener('click', closeDrawer)
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return
  const drawerOpen = document.getElementById('panel-detail').classList.contains('open')
  if (viewMode === 'board' && drawerOpen) closeDrawer()
})

// ── Keyboard navigation (power-user / flow) ──
function isTypingTarget(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}
function clearSearch() {
  searchQuery = ''
  SEARCH_FIELD_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.value = '' })
  if (viewMode === 'board') { if (window.renderBoard) window.renderBoard() }
  else renderAll(filterSessions(sessions, searchQuery), selectedKey, activeTab, true)
}
// The visible session keys, in DOM/render order (respects groups, sort, filter).
function visibleSessionKeys() {
  const sel = '#panel-list .list-card[data-key]'
  return [...document.querySelectorAll(sel)].map(el => el.dataset.key)
}
// Lightweight selection move for keyboard nav: toggle .selected in place + refresh
// the detail panel, WITHOUT rebuilding the whole list (full innerHTML replace caused
// a flicker) or revealing/hiding the embedded terminal (which flashed on every
// keypress in the Running tab). Mouse click still uses selectSession (full behavior).
function navSelect(key) {
  if (!key || key === selectedKey) return
  selectedKey = key
  window._lastSelectedKey = key
  document.querySelectorAll('#panel-list .list-card.selected').forEach(el => el.classList.remove('selected'))
  const card = document.querySelector(`#panel-list .list-card[data-key="${CSS.escape(key)}"]`)
  if (card) { card.classList.add('selected'); card.scrollIntoView({ block: 'nearest' }) }
  const s = sessions.find(x => sessionKey(x) === key)
  if (s && window.renderDetailPanel) window.renderDetailPanel(s, activeTab)
}
function moveSelection(delta) {
  const keys = visibleSessionKeys()
  if (!keys.length) return
  const i = keys.indexOf(selectedKey)
  const next = i === -1 ? (delta > 0 ? keys[0] : keys[keys.length - 1])
    : keys[Math.max(0, Math.min(keys.length - 1, i + delta))]
  navSelect(next)
}
document.addEventListener('keydown', (e) => {
  // Leave modifier combos to the OS / the Cmd+K palette (added in P2).
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const typing = isTypingTarget(document.activeElement)
  // Esc inside a search field clears + blurs it (otherwise let other handlers act).
  if (e.key === 'Escape') {
    const el = document.activeElement
    if (typing && (el.id === 'search-field' || el.id === 'board-search')) {
      clearSearch(); el.blur(); e.preventDefault()
    }
    return
  }
  if (typing) return
  // Remappable single-key actions (csm.keys). Case-insensitive for letters.
  const keys = window.getKeys ? window.getKeys() : DEFAULT_KEYS
  const km = (action) => {
    const key = keys[action]
    return key && (e.key === key || (e.key.length === 1 && key.length === 1 && e.key.toLowerCase() === key.toLowerCase()))
  }
  if (km('search')) {
    const el = document.getElementById(viewMode === 'board' ? 'board-search' : 'search-field')
    if (el) { el.focus(); el.select(); e.preventDefault() }
    return
  }
  if (km('tabRunning')) { switchTab('running'); e.preventDefault(); return }
  if (km('tabClosed')) { switchTab('closed'); e.preventDefault(); return }
  if (km('tabArchived')) { switchTab('archived'); e.preventDefault(); return }
  if (km('viewToggle')) { setViewMode(viewMode === 'board' ? 'list' : 'board'); e.preventDefault(); return }
  if (km('board')) { setViewMode('board'); e.preventDefault(); return }
  // Board: 2D arrow/hjkl navigation between cards & columns; Enter opens the slide-over.
  if (viewMode === 'board') {
    if (e.key === 'ArrowDown' || e.key === 'j') { window.boardNav && window.boardNav('down'); e.preventDefault(); return }
    if (e.key === 'ArrowUp' || e.key === 'k') { window.boardNav && window.boardNav('up'); e.preventDefault(); return }
    if (e.key === 'ArrowLeft' || e.key === 'h') { window.boardNav && window.boardNav('left'); e.preventDefault(); return }
    if (e.key === 'ArrowRight' || e.key === 'l') { window.boardNav && window.boardNav('right'); e.preventDefault(); return }
    if (e.key === 'Enter') { window.boardOpenFocused && window.boardOpenFocused(); e.preventDefault(); return }
    return
  }
  // ←/→ cycle the Running/Closed/Archived tab (list view — board owns ←/→).
  if (e.key === 'ArrowLeft') { cycleTab(-1); e.preventDefault(); return }
  if (e.key === 'ArrowRight') { cycleTab(1); e.preventDefault(); return }
  // Arrow / vim selection + Enter to launch — list view only (the board has its own 2D nav).
  if (viewMode === 'list') {
    if (e.key === 'ArrowDown' || e.key === 'j') { moveSelection(1); e.preventDefault(); return }
    if (e.key === 'ArrowUp' || e.key === 'k') { moveSelection(-1); e.preventDefault(); return }
    if (e.key === 'Enter' && selectedKey) {
      const s = sessions.find(x => sessionKey(x) === selectedKey)
      if (s && window.openSessionDefault) window.openSessionDefault(s)
      e.preventDefault()
    }
  }
})

// Wire up tab buttons
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab))
})

// Resizable panel
const resizeHandle = document.getElementById('resize-handle')
const panelLeft = document.getElementById('panel-left')
let isResizing = false
let startX = 0
let startWidth = 0

resizeHandle.addEventListener('mousedown', e => {
  isResizing = true
  startX = e.clientX
  startWidth = panelLeft.getBoundingClientRect().width
  resizeHandle.classList.add('dragging')
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
})

document.addEventListener('mousemove', e => {
  if (!isResizing) return
  const delta = e.clientX - startX
  const newWidth = Math.min(520, Math.max(180, startWidth + delta))
  panelLeft.style.width = `${newWidth}px`
  if (window.fitActiveTerminal) window.fitActiveTerminal()
})

document.addEventListener('mouseup', () => {
  if (!isResizing) return
  isResizing = false
  resizeHandle.classList.remove('dragging')
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
})

// Load the shared config first, then render everything from it.
// Seed every tab's count badge at launch (one-shot fetch of all three buckets), so
// the badges aren't empty until you visit each tab. The active tab then stays fresh
// via the poll; closed/archived counts refresh on visit (they change slowly).
async function seedTabCounts() {
  try {
    const [active, hist] = await Promise.all([
      window.api.getSessions(),
      window.api.getHistoricalAll(),   // {stale, closed, archived} in one scan
    ])
    window._tabCounts = {
      running: active.length + hist.stale.length,
      closed: hist.closed.length,
      archived: hist.archived.length,
    }
    window._waitingCount = active.filter(s => s.status === 'waiting').length
    if (window.updateTabBadges) window.updateTabBadges()
  } catch (e) { /* badges fall back to lazy per-visit fill */ }
}

// First-launch nudge: if the bundled session skills aren't in ~/.claude/skills yet,
// offer a one-click install (non-force — a fresh install, never clobbering edits).
// Dismissible (persisted), and silent once the skills are present.
async function maybeShowSkillsBanner() {
  const el = document.getElementById('skills-banner')
  if (!el || !window.api || !window.api.skillsStatus) return
  let status
  try { status = await window.api.skillsStatus() } catch { return }
  if (!status) return
  if (!status.installed) {
    if (localStorage.getItem('csm.skillsBannerDismissed') === '1') return
    el.innerHTML =
      '<span class="sb-text">The session skills (<code>/start-session</code>…) aren\'t installed yet. ' +
      'Install them into <code>~/.claude/skills</code> to drive ＋New, Resume and Restart.</span>' +
      '<button type="button" class="sb-install">Install skills</button>' +
      '<button type="button" class="sb-dismiss" aria-label="Dismiss">×</button>'
    el.hidden = false
    const install = el.querySelector('.sb-install')
    install.addEventListener('click', async () => {
      install.disabled = true; install.textContent = 'Installing…'
      const res = await window.api.installSkills(false)
      if (res && res.ok) {
        el.hidden = true; el.innerHTML = ''
        if (window.confirmAction) {
          const n = (res.installed || []).filter(s => s !== 'lib').length
          const extra = res.config_seeded ? ' A default config was created — set your spaces in Settings (⚙).' : ''
          window.confirmAction({ title: 'Session skills installed', body: `${n} skills are now in ~/.claude/skills.${extra} Open a fresh Claude Code session to use them.`, confirmLabel: 'OK' })
        }
      } else {
        install.disabled = false; install.textContent = 'Install skills'
        if (window.confirmAction) window.confirmAction({ title: 'Install failed', body: (res && res.error) || 'unknown error', confirmLabel: 'OK' })
      }
    })
    el.querySelector('.sb-dismiss').addEventListener('click', () => {
      localStorage.setItem('csm.skillsBannerDismissed', '1')
      el.hidden = true; el.innerHTML = ''
    })
    return
  }
  maybeShowSkillsUpdateBanner(el, status)
}

// Skills are present and at least one has moved upstream since the last confirmed sync
// point, with nothing local standing in the way (skills_status()'s `upstream_only`,
// computed against the .ao-base/ snapshot in src-tauri/src/skills.rs). Nudge toward the
// same safe update Settings offers, instead of making the user go find it — safe by
// construction, so unlike the old force-overwrite banner this applies directly, no
// confirm gate: a skill you customised via /skill-propose is never in `upstream_only`
// to begin with, it would show up in `local_only` or `conflicts` instead, untouched.
// Dismissal is keyed by bundle_epoch, not a flat flag: declining today's update must not
// suppress a later one shipped in a future build.
function maybeShowSkillsUpdateBanner(el, status) {
  const upstreamOnly = status.upstream_only || []
  if (!upstreamOnly.length) return
  const dismissKey = 'csm.skillsUpdateDismissedEpoch'
  const bundleEpoch = typeof status.bundle_epoch === 'number' ? status.bundle_epoch : 0
  if (localStorage.getItem(dismissKey) === String(bundleEpoch)) return
  const n = upstreamOnly.length
  el.innerHTML =
    `<span class="sb-text">${n} session skill${n === 1 ? '' : 's'} can be updated from upstream: ${upstreamOnly.join(', ')}.</span>` +
    '<button type="button" class="sb-install">Update skills</button>' +
    '<button type="button" class="sb-dismiss" aria-label="Dismiss">×</button>'
  el.hidden = false
  const update = el.querySelector('.sb-install')
  update.addEventListener('click', async () => {
    update.disabled = true; update.textContent = 'Updating…'
    const res = window.api.updateSkills ? await window.api.updateSkills() : { ok: false, error: 'updateSkills unavailable' }
    if (res && res.ok) {
      el.hidden = true; el.innerHTML = ''
      if (window.confirmAction) {
        const body = window.CSMSkillsUpdate ? window.CSMSkillsUpdate.updateResultText(res) : 'Done.'
        window.confirmAction({ title: 'Session skills updated', body: `${body} Open a fresh Claude Code session to pick them up.`, confirmLabel: 'OK' })
      }
    } else {
      update.disabled = false; update.textContent = 'Update skills'
      if (window.confirmAction) window.confirmAction({ title: 'Update failed', body: (res && res.error) || 'unknown error', confirmLabel: 'OK' })
    }
  })
  el.querySelector('.sb-dismiss').addEventListener('click', () => {
    localStorage.setItem(dismissKey, String(bundleEpoch))
    el.hidden = true; el.innerHTML = ''
  })
}

// Render the global usage status bar from ~/.claude/statusline-cache.json.
// Updates the model name + progress bars (5h, 7d, ctx). Hides the bar if cache is absent.
async function refreshUsage() {
  if (!window.api || !window.api.getUsage) return

  // The bar's context % + model reflect the SELECTED session (5h/7d stay global).
  const key = selectedKey || window._lastSelectedKey
  let sid = null
  if (key) {
    const pool = window._lastSessions || []
    const s = pool.find(x => (x.notesPath || x.sessionId || x.name || '') === key)
    sid = s ? s.sessionId
        : (window._terminalSession && (window._terminalSession.notesPath || window._terminalSession.sessionId || window._terminalSession.name || '') === key
           ? window._terminalSession.sessionId : null)
  }
  const usage = await window.api.getUsage(sid)
  const bar = document.getElementById('usage-bar')

  // Cache absent or error → hide the bar.
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    document.documentElement.classList.remove('has-usage')
    if (bar) bar.hidden = true
    return
  }

  const { model, fiveHourPct, sevenDayPct, contextPct, fiveHourResetsAt, sevenDayResetsAt, updatedAt } = usage

  // Show the bar only if we have at least one metric.
  const hasMetric = typeof fiveHourPct === 'number' || typeof sevenDayPct === 'number' || typeof contextPct === 'number'
  if (!hasMetric) {
    document.documentElement.classList.remove('has-usage')
    if (bar) bar.hidden = true
    return
  }

  if (!bar) return

  // Populate model name.
  const modelEl = document.getElementById('usage-model')
  if (modelEl) {
    modelEl.textContent = model || ''
    modelEl.hidden = !model
  }

  // Build the bars group.
  const barsGroup = document.getElementById('usage-bars-group')
  if (!barsGroup) return

  barsGroup.innerHTML = ''

  // Helper: create a single bar (5h, 7d, or ctx).
  const makeBar = (label, pct, resetsAt) => {
    if (typeof pct !== 'number' || pct < 0) return null

    const item = document.createElement('div')
    item.className = 'usage-bar-item'

    const labelEl = document.createElement('span')
    labelEl.className = 'usage-bar-label'
    labelEl.textContent = label

    const track = document.createElement('div')
    track.className = 'usage-bar-track'

    const fill = document.createElement('div')
    fill.className = 'usage-bar-fill'
    // Threshold: <70% idle-green, <90% busy-orange, >=90% waiting-red.
    if (pct < 70) {
      fill.classList.add('idle')
    } else if (pct < 90) {
      fill.classList.add('busy')
    } else {
      fill.classList.add('waiting')
    }
    fill.style.width = `${Math.min(100, pct)}%`

    track.appendChild(fill)

    const percentEl = document.createElement('span')
    percentEl.className = 'usage-bar-percent'
    percentEl.textContent = `${Math.round(pct)}%`

    item.appendChild(labelEl)
    item.appendChild(track)
    item.appendChild(percentEl)

    // Reset countdown sits next to the % (not below), with a slightly larger ↻ glyph
    // and a space before the time (e.g. "↻ 29m").
    if (typeof resetsAt === 'number' && window.CSMFormatters && window.CSMFormatters.formatResetIn) {
      const resetIn = window.CSMFormatters.formatResetIn(resetsAt)
      if (resetIn) {
        const resetEl = document.createElement('span')
        resetEl.className = 'usage-bar-reset'
        const icon = document.createElement('span')
        icon.className = 'usage-bar-reset-icon'
        icon.textContent = '↻'
        resetEl.appendChild(icon)
        resetEl.appendChild(document.createTextNode(' ' + resetIn))
        item.appendChild(resetEl)
      }
    }

    return item
  }

  // Add bars for each metric.
  if (typeof fiveHourPct === 'number') {
    const bar5h = makeBar('5h', fiveHourPct, fiveHourResetsAt)
    if (bar5h) barsGroup.appendChild(bar5h)
  }
  if (typeof sevenDayPct === 'number') {
    const bar7d = makeBar('7d', sevenDayPct, sevenDayResetsAt)
    if (bar7d) barsGroup.appendChild(bar7d)
  }
  if (typeof contextPct === 'number') {
    const barCtx = makeBar('ctx', contextPct)
    if (barCtx) barsGroup.appendChild(barCtx)
  }

  // Show the bar (and reserve its 26px in the layout via the has-usage class, so a user
  // without the piggyback cache leaves no empty gap at the bottom).
  bar.hidden = false
  document.documentElement.classList.add('has-usage')

  // Stale check: updatedAt > 15 min old → dim + add stale class.
  const isStale = typeof updatedAt === 'number' && Date.now() - updatedAt > 900000 // 15 min
  if (isStale) {
    bar.classList.add('stale')
  } else {
    bar.classList.remove('stale')
  }
}

async function boot() {
  // Sync the native window background to the saved theme (the inline head script already
  // set dataset.theme before first paint) so a resize never flashes the wrong colour.
  if (window.api && window.api.setWindowBg && window.getTheme) window.api.setWindowBg(window.getTheme() === 'dark')
  try {
    window.CSM_CONFIG = await window.api.getConfig()
    if (window.applyCategoryColors) window.applyCategoryColors(window.CSM_CONFIG.colorMap)
  } catch (err) {
    console.error('config load failed, using fallbacks:', err)
  }
  // Whatever the last Sync learned, so PR marks are already coloured on first paint.
  // Purely a disk read — nothing reaches the network until Sync is pressed.
  if (window.api.getPrStatus) window.api.getPrStatus().then(st => { window._prStatus = st || {} })
  window.installDelegatedHandlers()           // one delegated click handler on <body>
  renderCategoryFilters()                     // build the ⚲ Filter button (from config)
  populateNewSessionCategories()              // fill the +New dropdown (from config)
  fetchAndRender(true)                        // initial → sort
  seedTabCounts()                             // fill ALL tab badges at launch (not just on visit)
  maybeShowSkillsBanner()                     // first-launch nudge if skills aren't installed yet
  refreshUsage()                              // initial usage bar render
  renderUnmanagedSection()                    // initial: header present (collapsed), no discovery yet
  window.CSMDragList.init({
    root: document.getElementById('panel-left'),
    onReorder: async ({ kind, id, action, targetId, containerKey, index }) => {
      if (kind === 'session' && action === 'merge') {
        const category = containerKey.replace(/^cat:/, '')
        const st = window.CSMListOrg.load()
        const existing = st.categories[category]
        // If the target is already in a group, add the dragged session to it; else make a new group of the two.
        let gid = null
        if (existing) for (const [id, g] of Object.entries(existing.groups)) if (g.members.includes(targetId)) { gid = id; break }
        if (gid) {
          window.CSMListOrg.save(window.CSMListOrg.addToGroup(st, category, gid, id))
        } else {
          const ngid = 'lg-' + Math.random().toString(36).slice(2, 9)
          window.CSMListOrg.save(window.CSMListOrg.createGroupWith(st, category, ngid, [targetId, id], undefined))
        }
        fetchAndRender(false); return
      }
      if (kind === 'session' && containerKey.startsWith('grp:')) {
        const gidIdx = containerKey.lastIndexOf(':')
        const category = containerKey.slice(4, gidIdx)
        const gid = containerKey.slice(gidIdx + 1)
        window.CSMListOrg.save(window.CSMListOrg.addToGroup(window.CSMListOrg.load(), category, gid, id, index))
        fetchAndRender(false); return
      }
      if (kind === 'group' && containerKey.startsWith('cat:')) {
        const category = containerKey.slice(4)
        window.CSMListOrg.save(window.CSMListOrg.moveGroupRef(window.CSMListOrg.load(), category, id, index))
        fetchAndRender(false); return
      }
      if (kind === 'session' && containerKey.startsWith('cat:')) {
        const category = containerKey.slice(4)
        const st = window.CSMListOrg.load()
        window.CSMListOrg.save(window.CSMListOrg.moveSession(st, category, id, index))
        fetchAndRender(false)
        return
      }
      if (containerKey === '__toplevel__' && (kind === 'category' || kind === 'unmanaged')) {
        // Rebuild the top-level order from the rendered category list + unmanaged slot.
        const cfg = window.CSM_CONFIG || {}
        const cats = (window._listRenderedCats || []).slice()
        // Compose the display order (categories with the unmanaged slot at its index), move the dragged block, split back out.
        const uIdx = clampUnmanagedIndex(window.CSMListOrg.load().unmanagedIndex, cats.length)
        const display = [...cats]; display.splice(uIdx, 0, '__unmanaged__')
        const from = display.indexOf(kind === 'unmanaged' ? '__unmanaged__' : id)
        if (from < 0) return
        display.splice(from, 1)
        display.splice(index, 0, kind === 'unmanaged' ? '__unmanaged__' : id)
        const newU = display.indexOf('__unmanaged__')
        const newCats = display.filter(c => c !== '__unmanaged__')
        window.CSMListOrg.save(window.CSMListOrg.setUnmanagedIndex(window.CSMListOrg.load(), newU))
        const configured = (cfg.order || window.CSMCategories.order())
        const merged = [...newCats, ...configured.filter(c => !newCats.includes(c))]
        if (JSON.stringify(merged) !== JSON.stringify(cfg.order || [])) {
          const w = await window.api.setConfig({ ...cfg, order: merged })
          if (w && w.ok && window.reloadConfig) await window.reloadConfig()
        }
        fetchAndRender(false)
      }
    }
  })
  // poll → keep order frozen; skip if the previous fetch is still running (no stacking)
  setInterval(() => {
    if (viewMode === 'board') window.refreshBoard()
    else if (!fetchInFlight) fetchAndRender(false)
    refreshUsage()                            // refresh usage bar on every poll
  }, POLL_INTERVAL)
}
window.reloadConfig = async () => {           // called by Settings after save
  window.CSM_CONFIG = await window.api.getConfig()
  if (window.applyCategoryColors) window.applyCategoryColors(window.CSM_CONFIG.colorMap)
  renderCategoryFilters()
  populateNewSessionCategories()
  fetchAndRender(true)   // refreshes the active tab + its badge
  seedTabCounts()        // re-seed ALL tab badges — roots/categories may have changed
}

// v1 → v2 migration notification (emitted by Rust on startup).
if (window.api && window.api.onEvent) {
  window.api.onEvent('config_migrated_v2', () => {
    if (window.confirmAction) {
      window.confirmAction({
        title: 'Config upgraded',
        body: 'Your configuration has been upgraded to v2. A backup was saved. Changes will take effect on the next refresh.',
        confirmLabel: 'OK'
      })
    }
  })
}

boot()
