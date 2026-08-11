const STATUS_ORDER = { waiting: 0, busy: 1, idle: 2 }

// Inject one color rule per configured category (replaces the hardcoded CSS).
// Scoped exactly like the originals so inactive filter chips stay neutral.
function applyCategoryColors(colorMap) {
  if (!colorMap) return
  const css = Object.entries(colorMap).map(([name, color]) => {
    const c = CSS.escape(name)
    return `.category-name[data-cat="${c}"]{color:${color}}`
  }).join('')
  let el = document.getElementById('cat-colors')
  if (!el) { el = document.createElement('style'); el.id = 'cat-colors'; document.head.appendChild(el) }
  el.textContent = css
}
window.applyCategoryColors = applyCategoryColors

// Persisted across re-renders — categories start expanded
const collapsedCategories = new Set()
// Same, for the space sections shown in All mode (list view groups by space → category).
const collapsedSpaces = new Set()

// Frozen sort order: rebuilt only on tab switch / search / manual refresh,
// NOT on the 5s poll — so the list never reorders under the user's cursor.
let sortRank = new Map()        // sessionId → rank (lower = higher in list)
// Activity timestamps seen on the previous render — used to flash changed cards.
let prevActivity = new Map()    // sessionId → epoch ms

// Pure helpers live in renderer/lib/* (loaded as <script> before this file).
// Destructure so existing call sites stay unchanged.
const { truncate, escapeHtml, statusLabel, sessionTime, formatTimestamp, formatDateTime, formatAge } = window.CSMFormatters
const { renderMarkdown } = window.CSMMarkdown

function rebuildSortRank(sessions) {
  const sorted = [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a))
  sortRank = new Map(sorted.map((s, i) => [s.sessionId, i]))
}

function rankOf(s) {
  return sortRank.has(s.sessionId) ? sortRank.get(s.sessionId) : Number.MAX_SAFE_INTEGER
}

// Stable unique identity: sessionId can be null or duplicated across historical
// notes.md files, but notesPath is unique per session folder.
function sessionKey(s) {
  return s.notesPath || s.sessionId || s.name || ''
}

function clampUnmanagedIndex(i, n) { if (typeof i !== 'number' || i < 0) return 0; return Math.min(i, n) }

// Manual order + groups + drag apply only on the Running tab AND when NOT searching.
// Search is a find mode, not an organize mode: applying the model during a search would
// render groups with only their matching members (often none → an empty group title) and
// make drops confusing. Search → plain filtered list; organize with the search cleared.
function listReorgActive() {
  const q = (typeof searchQuery === 'string' ? searchQuery : '').trim()
  return activeTab === 'running' && !q
}

// Display title with the redundant leading "<CATEGORY> | " prefix stripped — the
// category is already shown (group header in list, chip on the board). Full name
// stays in the title= tooltip. Only strips when the name actually starts with it.
function displayName(s) {
  const name = s.name || 'unnamed'
  const cat = (s.category || '').trim()
  if (!cat) return name
  const re = new RegExp('^\\s*' + cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\|\\s*', 'i')
  const stripped = name.replace(re, '').trim()
  return stripped || name
}
window.displayName = displayName

// Set innerHTML only when it changed — avoids resetting cursor/hover every poll
function setHtml(el, html) {
  if (el._lastHtml !== html) {
    el.innerHTML = html
    el._lastHtml = html
  }
}

// Detail-panel template helpers (label is a trusted literal; value/body are
// already-built HTML). Consolidates the repeated meta-row / section boilerplate.
function metaRow(label, value) {
  return `<div class="meta-row"><span class="meta-label">${label}</span>${value}</div>`
}
function detailSection(label, body) {
  return `<div class="detail-section"><div class="section-label">${label}</div>${body}</div>`
}

// The session's meta rows (working dir / branch / worktree / category / dates).
// Shared by the detail info-pane and the info popover (shown over the embedded
// terminal), so both stay in sync — single source of truth for "the card info".
// A meta-row value listing references (tickets, PR urls). Each opens externally when we
// can build a URL for it; without one (no tracker configured) it stays plain text rather
// than a dead link.
function refLinks(values, hrefOf, labelOf = (v) => v) {
  return values.map(v => {
    const href = hrefOf(v)
    const label = escapeHtml(labelOf(v))
    return href
      ? `<button class="ref-link" data-url="${escapeHtml(href)}" title="${escapeHtml(v)}">${label}</button>`
      : `<span class="ref-plain" title="${escapeHtml(v)}">${label}</span>`
  }).join('<span class="ref-sep">·</span>')
}

function buildMetaRows(s, isHistorical) {
  const lastUpdate = formatDateTime(s.updatedAt || s.lastActivityAt)
  return [
    !isHistorical && s.cwd ? metaRow('Working directory', pathLink(s.cwd)) : '',
    (s.gitBranch || s.branch) ? metaRow('Branch', `🌿 ${escapeHtml(s.gitBranch || s.branch)}`) : '',
    !isHistorical && s.worktree ? metaRow('Worktree', pathLink(s.worktree, '🗂 ')) : '',
    s.category ? metaRow('Category', escapeHtml(s.category)) : '',
    // Tickets and PRs get their own rows: this is where a session's full reference list
    // is spelled out (a card only has room for "FEAT-1 +1"), and where you click through.
    ticketsOf(s).length ? metaRow(ticketsOf(s).length > 1 ? 'Tickets' : 'Ticket', refLinks(ticketsOf(s), ticketUrl)) : '',
    prLinksOf(s).length ? metaRow(prLinksOf(s).length > 1 ? 'PRs' : 'PR', refLinks(prLinksOf(s), (u) => u, prLabel)) : '',
    s.root ? metaRow('Space', escapeHtml(String(s.root))) : '',
    isHistorical && s.startedAt ? metaRow('Started', escapeHtml(s.startedAt)) : '',
    lastUpdate ? metaRow('Last update', escapeHtml(lastUpdate)) : '',
  ].filter(Boolean).join('')
}

// Abbreviate an absolute path to ~/… for display (home comes from the config).
function shortHome(p) {
  if (!p) return p
  const h = (window.CSM_CONFIG && window.CSM_CONFIG.home) || ''
  return h && (p === h || p.startsWith(h + '/')) ? '~' + p.slice(h.length) : p
}

// A path rendered clickable (opens it in Finder via the data-folder handler),
// shown abbreviated with ~/.
function pathLink(fullPath, prefix = '') {
  return `<span class="path-link" data-folder="${escapeHtml(fullPath)}" title="Open in Finder — ${escapeHtml(fullPath)}">${prefix}${escapeHtml(shortHome(fullPath))}</span>`
}

// The group a session falls under: its real category, else — for an unmanaged live
// session opened via the Claude Desktop app (no notes.md, so no category) — a dedicated
// "Claude Desktop" group instead of the generic catch-all "OTHER".
function displayCategory(s) {
  if (s.category) return s.category
  return s.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'OTHER'
}

// ── Left panel: grouped by category ──

function groupByCategory(sessions) {
  const groups = {}
  for (const s of sessions) {
    const cat = displayCategory(s)
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(s)
  }
  // Sort within each group by the frozen rank (stable across polls).
  for (const cat of Object.keys(groups)) {
    groups[cat].sort((a, b) => rankOf(a) - rankOf(b))
  }
  // Sort categories by configured order, unknown ones alphabetically after
  const order = window.CSMCategories.order()
  return Object.entries(groups).sort(([a], [b]) => {
    const ai = order.indexOf(a)
    const bi = order.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

function hasBusy(sessions) {
  return sessions.some(s => s.status === 'waiting' || s.status === 'busy' || s.status === 'shell')
}

// Pin state is owned by app.js (persisted in localStorage, capped). These read it.
function isPinnedSession(s) {
  return !!(window.isPinned && window.isPinned(sessionKey(s)))
}
function pinBtn(s) {
  const k = sessionKey(s)
  const p = isPinnedSession(s)
  return `<button class="pin-btn ${p ? 'pinned' : ''}" data-pin-key="${escapeHtml(k)}"
           title="${p ? 'Unpin' : 'Pin to top'}" aria-label="${p ? 'Unpin' : 'Pin to top'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg></button>`
}

// Lifecycle granularity: Running/Stale → Close → Closed → Archive → Archived.
// Close button — only on STALE sessions (in the Running tab: terminal gone, never
// /close-session'd). Click → confirm → close_session (stamps a close marker → Closed).
// Active (alive) sessions close via the terminal's "End session ✕"; the stale badge stays
// in the Running tab so un-closed sessions are still trackable until you close them.
function closeBtn(s) {
  if (!s.notesPath || s.state !== 'stale') return ''
  return `<button class="close-btn" data-close-notes="${escapeHtml(s.notesPath)}" data-close-name="${escapeHtml(s.name || '')}"
           title="Close this session (move to Closed)" aria-label="Close this session"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg></button>`
}

// Archive button — only on CLOSED sessions (not stale, not already archived). Stale
// sessions get the Close button instead (close them first). Click → confirm →
// archive_session (moves it to Archived).
function archiveBtn(s) {
  if (!s.notesPath || s.historyStatus !== 'closed') return ''
  return `<button class="archive-btn" data-archive-notes="${escapeHtml(s.notesPath)}" data-archive-name="${escapeHtml(s.name || '')}"
           title="Archive this session" aria-label="Archive this session"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg></button>`
}

// Archived sessions get a Trash button — moves the whole session folder to the macOS
// Trash (recoverable from Finder), to declutter the disk. ONLY archived: running/closed
// work is never deletable from the app (see delete_session's archived guard in Rust).
function deleteBtn(s) {
  if (s.historyStatus !== 'archived' || !s.notesPath) return ''
  const id = s.sessionId || slugOf(s) || ''
  return `<button class="delete-btn" data-delete-notes="${escapeHtml(s.notesPath)}" data-delete-name="${escapeHtml(s.name || '')}" data-delete-id="${escapeHtml(id)}"
           title="Delete — move to the Trash" aria-label="Delete this session (move to Trash)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg></button>`
}

// First "Next steps" line — the re-entry cue ("where was I"). Strips list bullets.
function firstNextStep(nextSteps) {
  if (!nextSteps) return ''
  const line = nextSteps.split('\n').map(l => l.trim()).find(Boolean) || ''
  return line.replace(/^[-*\d.)\]\s]+/, '').trim()
}

// Compact icon row (Jira ticket / PR / notes) shown on the list cards. Reuses
// the detail-panel pills, so a click opens the link/folder via the delegated handlers
// (which return early → the card isn't also selected). Visible in detailed + compact
// density, hidden in minimal (CSS). Returns '' when the session has none of the three.
function cardIcons(s) {
  // Ticket as a number label (consistent with the board); PR + notes stay as icons.
  // (No space label anywhere — the list groups into space sections, PINNED floats
  // above them all, and the board filters by space.)
  const icons = [ticketChip(s), prPill(s), notesPill(s.notesPath)].filter(Boolean).join('')
  return icons ? `<div class="card-icons">${icons}</div>` : ''
}

// Status-derived render bits for the list cards: 'waiting' → a WAIT badge
// (the one state needing action — busy/idle rely on the coloured dot alone, Tufte: no
// redundant ink); closed/archived/idle(no live pid) → greyed-white name via .historical.
// No "stale" text badge — age (ageBadge) carries that signal instead, everywhere.
function statusBits(s) {
  const stale = s.state === 'stale'
  const historical = s.state === 'closed' || s.state === 'archived'
  return {
    // Closed/archived/idle sessions have no live status → grey 'historical' dot, not the
    // green 'idle' default (they aren't running).
    dotClass: stale ? 'stale' : historical ? 'historical' : (s.status || 'idle'),
    historical: historical ? 'historical' : '',
    badge: s.status === 'waiting' ? `<span class="list-card-badge waiting">WAIT</span>` : '',
  }
}

// Compact "⏱ 3d" age pill — how long since this session was last active. Shown on every
// card (active, idle/stale, closed, archived) in the bottom icon row; replaces the old
// "stale" text badge with a neutral, always-present signal (no anxious wording).
function ageBadge(s) {
  // Only on grey (non-active) cards — stale/idle, closed, archived. Active sessions
  // (green busy / orange waiting / the live idle dot) never show it: the dot + live
  // status already say everything for those; age only matters once work has paused.
  if (s.state === 'active') return ''
  const t = sessionTime(s)
  if (!t) return ''
  const age = formatAge(t)
  if (!age) return ''
  const abs = formatDateTime(t)
  return `<span class="age-pill" title="Last activity: ${escapeHtml(abs)}">${svgIcon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>')}${escapeHtml(age)}</span>`
}

// Pause — set the session aside WITHOUT closing it: kills the embedded terminal's process
// (no /close-session wrap-up), the session goes idle (grey dot + age) but STAYS in
// Running, ready to Resume later. Only shown when a live embedded terminal actually
// exists for this session (nothing to pause for an external-terminal resume — the
// dashboard doesn't own that process). Distinct from Close (done, → Closed tab).
function pauseBtn(s) {
  const liveKey = window.liveTerminalKeyFor && window.liveTerminalKeyFor(s.sessionId, s.notesPath)
  if (!liveKey) return ''
  return `<button class="pause-btn" data-pause-sid="${escapeHtml(s.sessionId || '')}" data-pause-notes="${escapeHtml(s.notesPath || '')}"
           title="Pause — set aside without closing" aria-label="Pause this session">${svgIcon('<line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/>')}</button>`
}

function renderListCard(s, selectedKey, changed) {
  // Session summary (from /save-session or /close-session), hidden when there's none.
  // Full text — CSS (ellipsis) clips to the panel width, so widening the panel reveals more.
  const preview = escapeHtml(s.lastSummary || '')
  const next = firstNextStep(s.nextSteps)
  const { dotClass, historical, badge } = statusBits(s)
  // Selection is keyed on sessionKey (unique per notes.md) — sessionId can be
  // null or duplicated across historical notes, which would select two cards at once.
  return `
    <div class="list-card ${dotClass} ${historical} ${sessionKey(s) === selectedKey ? 'selected' : ''} ${changed ? 'just-updated' : ''} ${isPinnedSession(s) ? 'pinned' : ''}"
         data-key="${escapeHtml(sessionKey(s))}">
      <div class="list-card-header">
        <span class="status-dot ${dotClass}"></span>
        <span class="list-card-name" title="${escapeHtml(s.name)}">${escapeHtml(displayName(s))}</span>
        ${pauseBtn(s)}
        ${closeBtn(s)}
        ${archiveBtn(s)}
        ${deleteBtn(s)}
        ${pinBtn(s)}
      </div>
      ${preview ? `<div class="list-card-preview">${preview}</div>` : ''}
      ${next ? `<div class="list-card-next" title="Next: ${escapeHtml(next)}">↪ ${escapeHtml(truncate(next, 70))}</div>` : ''}
      ${(() => { const icons = cardIcons(s); const age = ageBadge(s)
         return (icons || badge || age) ? `<div class="list-card-foot">${icons}${age}${badge}</div>` : '' })()}
    </div>
  `
}

function groupBlock(category, g, byKey, selectedKey, changedKeys) {
  const gid = escapeHtml(g.id)
  // Colour the group by its category's colour (like the board colours its groups),
  // falling back to the app accent when the category has none.
  const cm = (window.CSM_CONFIG && window.CSM_CONFIG.colorMap) || {}
  const col = /^#[0-9a-fA-F]{6}$/.test(cm[category] || '') ? cm[category] : ''
  const accentStyle = col ? ` style="--accent:${col};--accent-rgb:${hexToRgbTriplet(col)}"` : ''
  const memberCards = g.members.map(k => {
    const s = byKey.get(k); if (!s) return ''
    return `<div class="list-drag-item" data-drag-kind="session" data-drag-id="${escapeHtml(k)}">${renderListCard(s, selectedKey, changedKeys.has(k))}</div>`
  }).join('')
  return `
    <div class="list-group" data-drag-kind="group" data-drag-id="${gid}"${accentStyle}>
      <div class="list-group-head" data-group="${gid}" data-cat="${escapeHtml(category)}">
        <span class="list-group-chev ${g.collapsed ? 'collapsed' : ''}" data-group-collapse>›</span>
        <span class="list-group-name" data-group-collapse data-nodrag title="Expand / collapse">${escapeHtml(g.name)}</span>
        <span class="list-group-count">${g.members.length}</span>
        <button type="button" class="list-group-edit" data-group-rename title="Rename group" aria-label="Rename group"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
        <button type="button" class="list-group-x" data-group-delete title="Delete group (keep sessions)" aria-label="Delete group">✕</button>
      </div>
      <div class="list-group-body ${g.collapsed ? 'collapsed' : ''}" data-drop-key="grp:${escapeHtml(category)}:${gid}" data-drop-accept="session">
        ${memberCards}
      </div>
    </div>`
}

function renderCategoryGroup(category, sessions, selectedKey, changedKeys) {
  const collapsed = collapsedCategories.has(category)
  const active = hasBusy(sessions)
  // The reorg model (manual order + groups + drag) is a RUNNING-tab feature. On
  // Closed/Archived the same category name holds DIFFERENT sessions (other keys), so
  // applying the model would render empty groups (title only, nothing inside). Those
  // tabs render plainly — no model, no groups, no drag.
  let body, dragAttrs = '', dropAttrs = ''
  if (listReorgActive()) {
    const st = window.CSMListOrg.load()
    const byKey = new Map(sessions.map(s => [sessionKey(s), s]))
    const liveKeys = sessions.slice().sort((a, b) => rankOf(a) - rankOf(b)).map(sessionKey)  // activity fallback order
    const items = window.CSMListOrg.orderedItems(st, category, liveKeys)
    body = items.map(it => {
      if (it.kind === 'session') {
        const s = byKey.get(it.key); if (!s) return ''
        return `<div class="list-drag-item" data-drag-kind="session" data-drag-id="${escapeHtml(it.key)}">${renderListCard(s, selectedKey, changedKeys.has(it.key))}</div>`
      }
      if (it.kind === 'group') return groupBlock(category, it, byKey, selectedKey, changedKeys)
      return ''
    }).join('')
    dragAttrs = ` data-drag-kind="category" data-drag-id="${escapeHtml(category)}"`
    dropAttrs = ` data-drop-key="cat:${escapeHtml(category)}" data-drop-accept="session"`
  } else {
    body = sessions.map(s => renderListCard(s, selectedKey, changedKeys.has(sessionKey(s)))).join('')
  }
  return `
    <div class="category-group"${dragAttrs}>
      <div class="category-header ${active ? 'has-active' : ''}" data-category="${escapeHtml(category)}">
        <span class="category-chevron ${collapsed ? 'collapsed' : ''}">›</span>
        <span class="category-name" data-cat="${escapeHtml(category)}">${escapeHtml(category)}</span>
        <span class="category-count">${sessions.length}</span>
      </div>
      <div class="category-sessions ${collapsed ? 'collapsed' : ''}"${dropAttrs}>
        ${body}
      </div>
    </div>
  `
}

// A space section: an expandable header wrapping that space's category groups. No
// per-card space labels — the section header is the only space marker. Sessions with no
// space fall under "—". Pinned sessions are NOT in here: they float above every space
// (see renderPanelList), so the pinned block is one list at the top of the column
// rather than one per space.
function renderSpaceSection(space, sessions, selectedKey, changedKeys) {
  const collapsed = collapsedSpaces.has(space)
  const active = hasBusy(sessions)
  const inner = groupByCategory(sessions)
    .map(([cat, sess]) => renderCategoryGroup(cat, sess, selectedKey, changedKeys))
    .join('')
  return `
    <div class="space-group">
      <div class="space-header ${active ? 'has-active' : ''}" data-space="${escapeHtml(space)}">
        <span class="space-chevron ${collapsed ? 'collapsed' : ''}">›</span>
        <span class="space-name">${escapeHtml(space)}</span>
        <span class="space-count">${sessions.length}</span>
      </div>
      <div class="space-sessions ${collapsed ? 'collapsed' : ''}">${inner}</div>
    </div>
  `
}

// Group sessions by space, ordered by the config's roots order ("—" for un-spaced last).
function groupBySpace(sessions) {
  const groups = {}
  for (const s of sessions) {
    const sp = s.root || '—'
    ;(groups[sp] = groups[sp] || []).push(s)
  }
  const order = ((window.CSM_CONFIG && window.CSM_CONFIG.roots) || []).map(r => r.name)
  return Object.entries(groups).sort(([a], [b]) => {
    const ai = order.indexOf(a), bi = order.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

// Empty / loading state for the session list. Distinguishes
// "still loading the first fetch" from genuinely empty, and a no-search-match.
function emptyListMessage() {
  if (!window._sessionsLoaded) return `<div class="list-empty">Loading sessions…</div>`
  const q = (typeof searchQuery === 'string' ? searchQuery : '').trim()
  if (q) return `<div class="list-empty">No sessions match “<strong>${escapeHtml(q)}</strong>”.</div>`
  const label = activeTab === 'running' ? 'No running or stale sessions.'
    : activeTab === 'archived' ? 'No archived sessions.'
    : 'No closed sessions yet.'
  return `<div class="list-empty">${label}<span class="list-empty-hint">Start one with ＋ New</span></div>`
}

// Flash detection: keys whose activity advanced since the last render. Shared by the
// list cards so they light up on change. Skips the very first render.
function computeChangedKeys(sessions) {
  const changed = new Set()
  const firstRender = prevActivity.size === 0
  for (const s of sessions) {
    const key = sessionKey(s)
    const now = sessionTime(s)
    const before = prevActivity.get(key)
    if (!firstRender && before !== undefined && now > before) changed.add(key)
    prevActivity.set(key, now)
  }
  // Prune sessions that vanished, so the Map can't grow unbounded over a long run.
  if (prevActivity.size > sessions.length) {
    const live = new Set(sessions.map(sessionKey))
    for (const k of prevActivity.keys()) if (!live.has(k)) prevActivity.delete(k)
  }
  return changed
}

// Per-tab count badges + a red "waiting" dot on Running. Counts come from
// window._tabCounts (filled per tab on visit); the current tab is always fresh.
function updateTabBadges() {
  const counts = window._tabCounts || {}
  const labels = { running: 'Running', closed: 'Closed', archived: 'Archived' }
  const waiting = window._waitingCount || 0
  document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
    const tab = btn.dataset.tab
    const n = counts[tab]
    const badge = (n != null) ? `<span class="tab-count">${n}</span>` : ''
    const dot = (tab === 'running' && waiting > 0)
      ? `<span class="tab-wait-dot" title="${waiting} waiting for you"></span>` : ''
    const html = `${labels[tab] || tab}${badge}${dot}`
    if (btn._badgeHtml !== html) { btn.innerHTML = html; btn._badgeHtml = html }
  })
}

function renderPanelList(sessions, selectedKey, changedKeys) {
  if (!sessions.length) { setHtml(document.getElementById('panel-list'), emptyListMessage()); return }

  // Two blocks float above everything, cross-space, in this order:
  //   1. "⚡ Needs you" (waiting sessions) — blocked work must never be buried, so it
  //      outranks even a pin. A waiting session that's also pinned appears HERE only,
  //      never twice.
  //   2. PINNED — at the top of the whole column, not per space and not per category:
  //      pins are the "these are my current threads" shortlist, and scattering them
  //      under their own section defeated that. No header and no category/space label
  //      on the cards — the filled bookmark is the marker.
  const multi = window.multiSpace && window.multiSpace()
  const waiting = sessions.filter(s => s.status === 'waiting')
  const notWaiting = sessions.filter(s => s.status !== 'waiting')
  const pinned = notWaiting.filter(isPinnedSession).sort((a, b) => rankOf(a) - rankOf(b))
  const therest = notWaiting.filter(s => !isPinnedSession(s))
  let html = ''
  if (waiting.length) {
    waiting.sort((a, b) => rankOf(a) - rankOf(b))
    html += renderCategoryGroup('⚡ Needs you', waiting, selectedKey, changedKeys)
  }
  if (pinned.length) {
    html += `<div class="list-pinned">${pinned.map(s => renderListCard(s, selectedKey, changedKeys.has(sessionKey(s)))).join('')}</div>`
  }
  if (multi) {
    html += groupBySpace(therest).map(([space, sess]) =>
      renderSpaceSection(space, sess, selectedKey, changedKeys)
    ).join('')
  } else {
    // Single space → no sections, just the category groups (pins already floated).
    const grouped = groupByCategory(therest)
    if (listReorgActive()) {
      // Running (no search): draggable category blocks in a top-level drop container,
      // with the movable unmanaged block interleaved at its stored index.
      const renderedCats = grouped.map(([c]) => c)
      window._listRenderedCats = renderedCats
      const catBlocks = grouped.map(([cat, sess]) => renderCategoryGroup(cat, sess, selectedKey, changedKeys))
      const uIdx = clampUnmanagedIndex(window.CSMListOrg.load().unmanagedIndex, catBlocks.length)
      const blocks = [...catBlocks]
      blocks.splice(uIdx, 0, `<div class="unmanaged-slot" data-drag-kind="unmanaged" data-drag-id="unmanaged"></div>`)
      html += `<div class="list-blocks" data-drop-key="__toplevel__" data-drop-accept="category unmanaged">${blocks.join('')}</div>`
    } else {
      // Closed/Archived, or Running during a search: plain category groups, no reorg
      // wrapper, no unmanaged block.
      html += grouped.map(([cat, sess]) => renderCategoryGroup(cat, sess, selectedKey, changedKeys)).join('')
    }
  }
  // Skip DOM rewrite when unchanged — preserves hover/cursor between idle polls.
  setHtml(document.getElementById('panel-list'), html)
}

// ── Right panel: session detail ──

// Actions are an icon toolbar: a service logo where there is one (Jira/GitHub,
// vendored under renderer/icons/), a clean line-icon otherwise, each with a hover
// tooltip (data-tip) + aria-label. The delegated handlers key on the data-* attrs
// (and .pill / .terminal-toggle-btn classes), so those are preserved verbatim.
const svgIcon = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`

// Place a fixed-position popover under its anchor, but flip ABOVE when it would
// overflow the bottom of the window; clamp into the viewport (with scroll via the
// element's overflow) if it fits neither way. Used by all the action popovers so
// none gets cropped near a window edge. `el` must already be in the DOM (measured).
function positionPopover(el, anchor, gap = 6) {
  const r = anchor.getBoundingClientRect()
  const vw = window.innerWidth, vh = window.innerHeight
  el.style.maxHeight = `${vh - 16}px`     // never taller than the window (then scrolls)
  const ew = el.offsetWidth, eh = el.offsetHeight
  let top
  if (r.bottom + gap + eh <= vh) top = r.bottom + gap            // below (fits)
  else if (r.top - gap - eh >= 8) top = r.top - gap - eh         // above (fits)
  else top = Math.max(8, vh - eh - 8)                            // clamp to viewport
  const left = Math.max(8, Math.min(r.left, vw - ew - 8))
  el.style.top = `${Math.round(top)}px`
  el.style.left = `${Math.round(left)}px`
}

// Embedded terminal — the primary action, moved out of the header into Actions.
// Keeps the .terminal-toggle-btn class (its handler) and NO .pill class (so the
// .pill[data-cwd] "external terminal" handler doesn't also match it).
// The session folder slug (for /restart), derived from notesPath.
function slugOf(s) {
  if (!s.notesPath) return ''
  return s.notesPath.replace(/\/notes\.md$/, '').split('/').pop() || ''
}

function embeddedTerminalAction(s) {
  const glyph = svgIcon('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>')
  if (canResume(s)) {
    return `<button class="act act-primary terminal-toggle-btn" aria-label="Open integrated terminal" data-tip="Open integrated terminal"
             data-session="${escapeHtml(s.sessionId)}" data-cwd="${escapeHtml(s.cwd || '')}" data-notes="${escapeHtml(s.notesPath || '')}">${glyph}</button>`
  }
  // Transcript gone → can't --resume, but we can /restart from notes in the embedded
  // terminal (data-restart-slug switches the pty command). Needs a notes slug.
  const slug = slugOf(s)
  if (slug) {
    return `<button class="act act-primary terminal-toggle-btn" aria-label="Restart in integrated terminal" data-tip="Restart in integrated terminal (from notes)"
             data-session="${escapeHtml(s.sessionId || slug)}" data-cwd="${escapeHtml(s.cwd || '')}" data-restart-slug="${escapeHtml(slug)}" data-notes="${escapeHtml(s.notesPath || '')}">${glyph}</button>`
  }
  return ''
}

// Tracker-neutral tag glyph (currentColor → adapts to theme). Works for any
// issue tracker — the link is just <ticketBaseUrl> + <ticket>.
const ICON_TICKET = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.414 2.414 0 0 0 3.414 0l6.586-6.586a2.414 2.414 0 0 0 0-3.414z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg>`
// GitHub mark as currentColor (not a fixed-white asset) → legible on both light & dark themes.
const ICON_GITHUB = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`

// ── Link lists (PRs / tickets) ──
// A session can reference SEVERAL PRs and tickets — one task split across two PRs, or
// an epic plus its sub-task. The backend sends the whole ordered list (prLinks /
// tickets) plus the primary as prLink / ticket; these read the list and fall back to
// the primary so an older payload still renders.
function linksOf(s, listKey, primaryKey) {
  const list = Array.isArray(s[listKey]) ? s[listKey].filter(Boolean) : []
  if (list.length) return list
  return s[primaryKey] ? [s[primaryKey]] : []
}
const prLinksOf = (s) => linksOf(s, 'prLinks', 'prLink')
// Junk guard: a frontmatter `ticket: ""` that survived as quotes is not a ticket.
const ticketsOf = (s) => linksOf(s, 'tickets', 'ticket').filter(t => /[a-z0-9]/i.test(t))
// Explicit exports — a top-level `const` in a classic script is NOT a window property,
// and board.js renders the same link chips.
window.prLinksOf = prLinksOf
window.ticketsOf = ticketsOf

// `owner/repo#123` from a PR URL — the label in the picker popover. Parsed locally
// (no API call), so it works offline and without a GitHub token; falls back to the
// raw URL if the shape is unexpected.
function prLabel(url) {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url || '')
  return m ? `${m[1]}/${m[2]}#${m[3]}` : (url || '')
}

const ticketUrl = (t) => {
  const base = (window.CSM_CONFIG && window.CSM_CONFIG.ticketBaseUrl) || ''
  return base ? base + t : ''
}

// The picker button carries only (kind, session key) — the menu's contents are derived
// from the live session at CLICK time, never stashed at render time. That matters
// because setHtml skips the DOM rewrite when the markup is unchanged: any render-time
// registry would keep growing on each poll while the DOM held ids from an older render.
function linkMenuAttrs(kind, s) {
  return `data-linkmenu="${kind}" data-linkmenu-key="${escapeHtml(sessionKey(s))}"`
}

// Resolve a picker button back to its menu payload: the session's links, labelled.
function linkMenuFor(s, kind) {
  if (!s) return null
  if (kind === 'ticket') {
    const tickets = ticketsOf(s)
    return { kind, head: `Tickets · ${tickets.length}`, notesPath: s.notesPath || '',
      items: tickets.map(t => ({ label: t, url: ticketUrl(t) })) }
  }
  const prs = prLinksOf(s)
  return { kind, head: `Pull requests · ${prs.length}`, notesPath: s.notesPath || '',
    items: prs.map(u => ({ label: prLabel(u), url: u })) }
}

function ticketPill(s) {
  const tickets = ticketsOf(s)
  // Only show the icon when it can actually open something — i.e. a tracker base URL
  // is configured (Jira, Linear, GitHub Issues, Azure DevOps…). Without one, a dead
  // icon just confuses; the ticket id still shows in the detail meta row.
  if (!tickets.length || !ticketUrl(tickets[0])) return ''
  if (tickets.length === 1) {
    const t = tickets[0]
    return `<button class="act pill" data-url="${escapeHtml(ticketUrl(t))}" aria-label="${escapeHtml(t)}" data-tip="${escapeHtml(t)} · open ticket">${ICON_TICKET}</button>`
  }
  return `<button class="act pill multi" ${linkMenuAttrs('ticket', s)} aria-label="${tickets.length} tickets" data-tip="${tickets.length} tickets · pick one">${ICON_TICKET}<span class="multi-count">${tickets.length}</span></button>`
}

// Ticket as a NUMBER label (e.g. FEAT-1842) for list + card views — the id reads at a
// glance, matching the board's chip. Extra tickets show as a `+N` suffix and turn the
// chip into a picker. Clickable when a tracker URL is configured, a plain label
// otherwise (the detail toolbar uses the compact icon, ticketPill).
function ticketChip(s) {
  const tickets = ticketsOf(s)
  if (!tickets.length) return ''
  const label = escapeHtml(tickets[0])
  const extra = tickets.length > 1 ? `<span class="multi-suffix">+${tickets.length - 1}</span>` : ''
  if (!ticketUrl(tickets[0])) return `<span class="ticket-tag" title="${label}">${label}${extra}</span>`
  if (tickets.length === 1) {
    return `<button class="ticket-tag ticket-chip" data-url="${escapeHtml(ticketUrl(tickets[0]))}" data-tip="${label} · open ticket">${label}</button>`
  }
  return `<button class="ticket-tag ticket-chip multi" ${linkMenuAttrs('ticket', s)} data-tip="${tickets.length} tickets · pick one">${label}${extra}</button>`
}

// The GitHub icon for a session's PRs: one link opens straight away (unchanged),
// several show a count badge and open the picker.
function prPill(s) {
  const prs = prLinksOf(s)
  if (!prs.length) return ''
  if (prs.length === 1) {
    return `<button class="act pill" data-url="${escapeHtml(prs[0])}" aria-label="Pull request" data-tip="Open ${escapeHtml(prLabel(prs[0]))} on GitHub">${ICON_GITHUB}</button>`
  }
  return `<button class="act pill multi" ${linkMenuAttrs('pr', s)} aria-label="${prs.length} pull requests" data-tip="${prs.length} PRs · pick one">${ICON_GITHUB}<span class="multi-count">${prs.length}</span></button>`
}


// A session can only be resumed if it has a real session id (UUID-ish, no spaces).
// Placeholders like "to fill" or null mean there's no Claude session to attach to.
function isResumable(sessionId) {
  return !!sessionId && /^[A-Za-z0-9_-]+$/.test(sessionId)
}

// Can we `--resume` this session? Needs a real sessionId AND (for historical
// sessions) an existing transcript — get_historical_sessions sets resumable:false
// when the .jsonl is gone, so resume would fail. Running sessions omit the flag
// (always live → resumable). When false, only Restart (rebuild from notes) works.
function canResume(s) {
  return isResumable(s.sessionId) && s.resumable !== false
}

// External terminal — resume in the user's terminal app (set in Settings). Keeps
// .pill + data-cwd so the existing handler fires; the ❯_-in-a-box arrow reads as
// "open in a full external window".
function itermPill(s) {
  if (!canResume(s)) return ''
  return `<button class="act pill" aria-label="Resume in your terminal" data-tip="Resume in your terminal (new window)"
           data-cwd="${escapeHtml(s.cwd || '')}" data-session="${escapeHtml(s.sessionId)}" data-notes="${escapeHtml(s.notesPath || '')}">${svgIcon('<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/>')}</button>`
}

function notesPill(notesPath) {
  if (!notesPath) return ''
  const folder = notesPath.replace(/\/notes\.md$/, '')
  return `<button class="act pill" aria-label="Open notes folder" data-tip="Open notes folder"
           data-folder="${escapeHtml(folder)}">${svgIcon('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>')}</button>`
}

// Info (ⓘ) button — only shown in the header when the embedded terminal covers the
// info pane. Click pops the session's meta rows over the terminal (terminal stays up).
function infoPill() {
  return `<button class="act" data-info-pop aria-label="Session details" data-tip="Session details">${svgIcon('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="16" y2="12"/><line x1="12" x2="12.01" y1="8" y2="8"/>')}</button>`
}

// Popover showing the selected session's meta rows (over the embedded terminal).
function closeInfoPopover() {
  const m = document.getElementById('info-pop')
  if (m) m.remove()
  document.removeEventListener('click', infoPopOutside, true)
  document.removeEventListener('keydown', infoPopEsc, true)
}
function infoPopOutside(e) {
  if (!e.target.closest('#info-pop') && !e.target.closest('[data-info-pop]')) closeInfoPopover()
}
function infoPopEsc(e) { if (e.key === 'Escape') closeInfoPopover() }
function openInfoPopover(anchor) {
  closeInfoPopover()
  // The ⓘ button lives in the header shown OVER the embedded terminal, where the
  // selection may have fallen back to the terminal session (selectedKey cleared).
  // Resolve by selectedKey first, then that fallback — else the button does nothing.
  let sel = (window._lastSessions || []).find(x => sessionKey(x) === window._lastSelectedKey)
  if (!sel && window._terminalSession) sel = window._terminalSession
  if (!sel) return
  const rows = buildMetaRows(sel, activeTab !== 'running')
  const pop = document.createElement('div')
  pop.className = 'info-pop'
  pop.id = 'info-pop'
  pop.innerHTML = `<div class="info-pop-head">Session details</div>` +
    (rows ? `<div class="detail-meta">${rows}</div>` : `<div class="info-pop-empty">No details available</div>`)
  document.body.appendChild(pop)
  positionPopover(pop, anchor)
  setTimeout(() => {
    document.addEventListener('click', infoPopOutside, true)
    document.addEventListener('keydown', infoPopEsc, true)
  }, 0)
}

// ── Link picker popover ──
// Shown when a session has SEVERAL PRs / tickets: pick which one to open. Reuses the
// board menu's geometry + dismiss pattern. The last row opens the editor, so the
// popover is also the way in to attaching another link.
function closeLinkMenu() {
  const m = document.getElementById('link-menu')
  if (m) m.remove()
  document.removeEventListener('click', linkMenuOutside, true)
  document.removeEventListener('keydown', linkMenuEsc, true)
}
function linkMenuOutside(e) {
  if (!e.target.closest('#link-menu') && !e.target.closest('[data-linkmenu]')) closeLinkMenu()
}
function linkMenuEsc(e) { if (e.key === 'Escape') closeLinkMenu() }
function openLinkMenu(anchor, menu) {
  closeLinkMenu()
  const pop = document.createElement('div')
  pop.className = 'board-menu link-menu'
  pop.id = 'link-menu'
  const editLabel = menu.kind === 'pr' ? 'Add / edit PRs…' : 'Add / edit tickets…'
  pop.innerHTML =
    `<div class="board-menu-head">${escapeHtml(menu.head)}</div>` +
    menu.items.map((it, i) =>
      `<button class="board-menu-item" data-link-open="${i}"${it.url ? '' : ' disabled'}>` +
      `<span class="board-menu-check">›</span><span class="board-menu-name">${escapeHtml(it.label)}</span></button>`
    ).join('') +
    // Editing needs a writable notes.md — an unmanaged session has none.
    (menu.notesPath
      ? `<div class="board-menu-sep"></div><button class="board-menu-item link-menu-edit">${editLabel}</button>`
      : '')
  document.body.appendChild(pop)
  positionPopover(pop, anchor)
  pop.querySelectorAll('[data-link-open]').forEach(btn => {
    btn.addEventListener('click', () => {
      const it = menu.items[Number(btn.dataset.linkOpen)]
      if (it && it.url) window.api.openExternal(it.url)
      closeLinkMenu()
    })
  })
  const edit = pop.querySelector('.link-menu-edit')
  if (edit) {
    edit.addEventListener('click', () => {
      closeLinkMenu()
      openEditRefs(menu.notesPath)
    })
  }
  setTimeout(() => {
    document.addEventListener('click', linkMenuOutside, true)
    document.addEventListener('keydown', linkMenuEsc, true)
  }, 0)
}

// ── Inline link editor ──
// One entry per line → window.api.setPrLinks / setTickets (which rewrite the notes.md
// frontmatter). A textarea rather than N inputs: it makes "paste the second PR on a new
// line" the whole interaction, and reordering (the first line is the primary shown on
// the card) is just editing text. Empty box = clear them all. Reuses the outside-click /
// Esc dismiss pattern.
// Editing a session's references. One dialog for every editable field, opened by the
// single ✎ in the detail toolbar — previously each field had its own ✎ + popover, which
// turned that row into a wall of buttons. Values are one per line; the first is the
// primary shown on the card, and an empty box clears the field.
const LINK_EDITORS = {
  pr: {
    invalid: (v) => (typeof isPrUrl === 'function' && !isPrUrl(v)) ? `Not a GitHub PR URL: ${v}` : '',
    save: (notesPath, values) => window.api.setPrLinks(notesPath, values),
    current: (s) => prLinksOf(s),
  },
  ticket: {
    invalid: (v) => /^[A-Za-z][A-Za-z0-9]*-[0-9]+$/.test(v) ? '' : `Not a ticket id: ${v}`,
    save: (notesPath, values) => window.api.setTickets(notesPath, values),
    current: (s) => ticketsOf(s),
  },
}

const editRefsModal = () => document.getElementById('edit-refs-modal')
let editRefsNotes = ''

// Resolve the session being edited from its notes.md — the same path the button carries.
function sessionForNotes(notesPath) {
  const pool = window._lastSessions || []
  return pool.find(x => (x.notesPath || '') === notesPath) || null
}

function openEditRefs(notesPath) {
  const dlg = editRefsModal()
  if (!dlg) return
  editRefsNotes = notesPath
  const s = sessionForNotes(notesPath) || {}
  document.getElementById('edit-tickets').value = LINK_EDITORS.ticket.current(s).join('\n')
  document.getElementById('edit-prs').value = LINK_EDITORS.pr.current(s).join('\n')
  const err = document.getElementById('edit-refs-error')
  if (err) err.hidden = true
  dlg.showModal()
}

// Split a textarea into trimmed, non-empty lines.
const editRefsLines = (v) => String(v || '').split('\n').map(x => x.trim()).filter(Boolean)

async function saveEditRefs() {
  const err = document.getElementById('edit-refs-error')
  const tickets = editRefsLines(document.getElementById('edit-tickets').value)
  const prs = editRefsLines(document.getElementById('edit-prs').value)
  // Validate everything before writing anything — a half-applied save would leave the
  // notes.md disagreeing with what the box showed.
  const bad = [...tickets.map(v => LINK_EDITORS.ticket.invalid(v)),
               ...prs.map(v => LINK_EDITORS.pr.invalid(v))].find(Boolean)
  if (bad) { if (err) { err.textContent = bad; err.hidden = false } return }
  // Sequential, NOT Promise.all: both commands read-modify-write the same notes.md, so
  // running them together made the second one start from the pre-edit content and drop
  // the first one's change. The ticket write must see the PR write already applied.
  const results = [await LINK_EDITORS.ticket.save(editRefsNotes, tickets)]
  results.push(await LINK_EDITORS.pr.save(editRefsNotes, prs))
  const failed = results.find(r => r && r.ok === false)
  if (failed) { if (err) { err.textContent = failed.error || 'Could not save.'; err.hidden = false } return }
  editRefsModal().close()
  if (window.refreshSessions) window.refreshSessions()
}

document.addEventListener('DOMContentLoaded', () => {
  const cancel = document.getElementById('edit-refs-cancel')
  const save = document.getElementById('edit-refs-save')
  if (cancel) cancel.addEventListener('click', () => editRefsModal().close())
  if (save) save.addEventListener('click', saveEditRefs)
})

// Opens a small menu to pick which board column the session goes in (or to remove
// it). Lives in the detail Actions toolbar; accent-filled when already on the board.
function boardPill(s) {
  const key = sessionKey(s)
  if (!key) return ''
  const placed = !!(window.CSMBoard && CSMBoard.load().placements[key])
  return `<button class="act ${placed ? 'act-primary' : ''}" data-board-menu="${escapeHtml(key)}"
           aria-label="${placed ? 'On the board' : 'Add to board'}" data-tip="${placed ? 'On the board — click to move or remove' : 'Add to a board column'}">${svgIcon('<path d="M6 5v11"/><path d="M12 5v6"/><path d="M18 5v14"/>')}</button>`
}

// Popover menu anchored under the board button: lists the visible columns (current
// one checked) and, when placed, a Remove item. Picking one places/moves/removes the
// session, then refreshes the detail pill and the board if it's open.
function closeBoardMenu() {
  const m = document.getElementById('board-menu')
  if (m) m.remove()
  document.removeEventListener('click', boardMenuOutside, true)
  document.removeEventListener('keydown', boardMenuEsc, true)
}
function boardMenuOutside(e) {
  if (!e.target.closest('#board-menu') && !e.target.closest('[data-board-menu]')) closeBoardMenu()
}
function boardMenuEsc(e) { if (e.key === 'Escape') closeBoardMenu() }
function openBoardMenu(anchor, key) {
  closeBoardMenu()
  if (!window.CSMBoard) return
  const st = CSMBoard.load()
  const current = st.placements[key] || null
  const cols = st.columns.filter(c => !c.hidden)
  const items = cols.map(c => {
    const on = c.id === current
    const tint = /^#[0-9a-fA-F]{6}$/.test(c.color || '') ? ` style="color:${c.color}"` : ''
    return `<button class="board-menu-item${on ? ' active' : ''}" data-col="${escapeHtml(c.id)}">
      <span class="board-menu-check">${on ? '✓' : ''}</span>
      <span class="board-menu-name"${tint}>${escapeHtml(c.name)}</span></button>`
  }).join('')
  const remove = current
    ? `<div class="board-menu-sep"></div><button class="board-menu-item board-menu-remove" data-remove="1">Remove from board</button>`
    : ''
  const menu = document.createElement('div')
  menu.className = 'board-menu'
  menu.id = 'board-menu'
  menu.innerHTML = `<div class="board-menu-head">${current ? 'Move to column' : 'Add to column'}</div>${items}${remove}`
  document.body.appendChild(menu)
  positionPopover(menu, anchor)
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.board-menu-item'); if (!item) return
    const s = CSMBoard.load()
    const next = item.dataset.remove ? CSMBoard.unplaceSession(s, key) : CSMBoard.placeSession(s, key, item.dataset.col)
    CSMBoard.save(next)
    closeBoardMenu()
    const sel = (window._lastSessions || []).find(x => sessionKey(x) === window._lastSelectedKey)
    if (sel && window.renderDetailPanel) renderDetailPanel(sel, activeTab)
    if (window.viewMode === 'board' && window.renderBoard) window.renderBoard()
  })
  // Defer the dismiss listeners so the opening click doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('click', boardMenuOutside, true)
    document.addEventListener('keydown', boardMenuEsc, true)
  }, 0)
}

// Restart a closed/archived session via the /restart skill: reloads its notes
// summary into a fresh session and re-registers it as active. (Distinct from
// "Resume", which reloads the full raw transcript and needs a live sessionId.)
function restartPill(s) {
  const slug = slugOf(s)
  if (!slug) return ''
  return `<button class="act pill" aria-label="Restart in your terminal" data-tip="Restart from notes, in your terminal"
           data-restore-slug="${escapeHtml(slug)}" data-restore-sid="${escapeHtml(s.sessionId || '')}">${svgIcon('<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8"/><path d="M3 3v5h5"/>')}</button>`
}

// ── Open actions (Option A): destination toggle + Resume/Restart verbs ──
// The toggle is a sticky pref (window.getOpenIn); both verbs honour it. Resume only
// when the transcript is present; Restart whenever a notes slug exists.
function destinationToggle() {
  const dest = (window.getOpenIn && window.getOpenIn()) || 'embedded'
  const kbd = svgIcon('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>')
  const ext = svgIcon('<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/>')
  const seg = (val, label, glyph) =>
    `<button type="button" class="open-dest ${dest === val ? 'active' : ''}" data-open-dest="${val}" data-tip="Open sessions in ${label}">${glyph}${label}</button>`
  return `<span class="open-toggle">${seg('embedded', 'Embedded', kbd)}${seg('terminal', 'Terminal', ext)}</span>`
}
function resumeBtn(s) {
  if (!canResume(s)) return ''
  return `<button class="act-verb primary" data-open-resume data-session="${escapeHtml(s.sessionId)}" data-cwd="${escapeHtml(s.cwd || '')}" data-notes="${escapeHtml(s.notesPath || '')}"
           data-tip="Resume this session">${svgIcon('<polygon points="6 3 20 12 6 21 6 3"/>')}Resume</button>`
}
function restartBtn(s) {
  const slug = slugOf(s)
  if (!slug) return ''
  return `<button class="act-verb" data-open-restart data-restore-slug="${escapeHtml(slug)}" data-restore-sid="${escapeHtml(s.sessionId || '')}" data-cwd="${escapeHtml(s.cwd || '')}" data-notes="${escapeHtml(s.notesPath || '')}"
           data-tip="Restart from notes">${svgIcon('<path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8"/><path d="M3 3v5h5"/>')}Restart</button>`
}

function renderDetailPanel(s, tab = 'running') {
  const headerEl   = document.getElementById('detail-header')
  const infoEl     = document.getElementById('detail-info-pane')

  if (!s) {
    setHtml(headerEl, '')
    setHtml(infoEl, '<div class="detail-empty">← Select a session</div>')
    return
  }

  // A stale (idle) session lives in the Running tab but has no live pid — render it like
  // a historical record (Restart/Resume/Archive, "Started" meta) with an IDLE badge (the
  // ageBadge pill carries the "how long" signal elsewhere; no anxious "STALE" wording).
  const stale = s.state === 'stale'
  const isHistorical = s.state ? s.state !== 'active' : (tab !== 'running')
  const statusStr = stale
    ? 'IDLE'
    : isHistorical
      ? (s.historyStatus === 'archived' ? 'ARCHIVED' : 'CLOSED')
      : statusLabel(s.status)
  const dotClass = stale ? 'stale' : (isHistorical ? 'historical' : (s.status || 'idle'))

  // Header: dot + name + (status badge only when it says something — IDLE is noise,
  // the dot colour already conveys it; busy/waiting + historical CLOSED/ARCHIVED stay).
  // The terminal toggle now lives in Actions as an icon.
  // While the embedded terminal covers the info pane, the reference actions (ticket /
  // PR / notes / board) ride on the title line; the name (flex:1) ellipsizes to make room.
  const showBadge = isHistorical || (!!s.status && s.status !== 'idle')
  const termOpen = window.getTerminalVisible && window.getTerminalVisible()
  // Edit rides on the header too: with the terminal up, the ticket/PR icons are hidden
  // whenever the session has none attached — which is exactly when the user needs to
  // attach one (a PR opened mid-session only lands in notes.md at the next /save-session).
  const editBtn = s.notesPath
    ? `<button class="act" data-edit-refs="${escapeHtml(s.notesPath)}" aria-label="Edit session details" data-tip="Edit PRs & tickets">${svgIcon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>')}</button>`
    : ''
  const headerActions = termOpen
    ? [infoPill(), ticketPill(s), prPill(s), notesPill(s.notesPath), boardPill(s), editBtn].filter(Boolean).join('')
    : ''
  setHtml(headerEl, `
    <div class="detail-header-row">
      <span class="detail-status-dot ${dotClass}"></span>
      <h1 class="detail-name" title="${escapeHtml(s.name)}">${escapeHtml(displayName(s))}</h1>
      ${showBadge ? `<span class="detail-status-badge ${isHistorical ? 'historical' : ''}">${statusStr}</span>` : ''}
      ${headerActions ? `<div class="header-actions">${headerActions}</div>` : ''}
      <button class="drawer-ctl drawer-detach" title="Detach into its own window"
              data-key="${escapeHtml(sessionKey(s))}">◳</button>
      <button class="drawer-ctl drawer-close" title="Close" onclick="window.closeDrawer()">✕</button>
    </div>
  `)

  // Info pane content
  const metaRows = buildMetaRows(s, isHistorical)

  const goalSection = s.goal ? detailSection('Goal', `<div class="detail-goal">${escapeHtml(s.goal)}</div>`) : ''

  // "Summary" = the latest Session-history summary (written by /save-session or
  // /close-session), for running and historical alike. Raw transcript output is no longer
  // shown; hidden entirely when there's no summary yet.
  const activitySection = s.lastSummary
    ? detailSection('Summary', `<div class="detail-activity">${escapeHtml(s.lastSummary)}</div>`)
    : ''

  const nextStepsSection = s.nextSteps
    ? detailSection('Next steps', `<div class="detail-next-steps">${renderMarkdown(s.nextSteps)}</div>`)
    : ''

  // Icon toolbar: embedded terminal (primary) first, then external terminal, then
  // ticket / PR / restart / notes — each only when relevant.
  // Launch actions grouped first (resume embedded · resume external · restart),
  // then the reference actions (ticket · PR · notes).
  // Launch cluster: destination toggle + Resume/Restart (Option A) — replaces the
  // old mixed icons (embedded/iterm × resume/restart). Then a separator, then the
  // reference actions (ticket / PR / notes / board).
  const resume = resumeBtn(s)
  const restart = restartBtn(s)
  // Only show the destination toggle when there's at least one verb to apply it to.
  const launch = (resume || restart) ? [destinationToggle(), resume, restart].filter(Boolean).join('') : ''
  // References are listed in the meta rows above, so the toolbar keeps only the links
  // that open something plus ONE Edit — a ✎ per field made this row a wall of buttons.
  const refs = [notesPill(s.notesPath), boardPill(s), editBtn].filter(Boolean).join('')
  const actions = launch + (launch && refs ? '<span class="act-sep"></span>' : '') + refs

  setHtml(infoEl, `
    ${metaRows ? `<div class="detail-meta">${metaRows}</div>` : ''}
    ${goalSection}
    ${activitySection}
    ${nextStepsSection}
    ${actions ? detailSection('Actions', `<div class="acts">${actions}</div>`) : ''}
  `)
}

// ── Main render ──

function renderAll(sessions, selectedKey, tab = 'running', resort = false) {
  if (window._listDragging || window._listEditing) return   // never rebuild the DOM under an active drag or inline edit
  window._lastSessions = sessions
  // Rebuild the sort order only when explicitly asked (tab switch, search, manual
  // refresh, initial load). On the 5s poll, resort=false keeps the order frozen.
  if (resort || sortRank.size === 0) rebuildSortRank(sessions)
  const changedKeys = computeChangedKeys(sessions)   // keys whose activity advanced → flash
  renderPanelList(sessions, selectedKey, changedKeys)
  updateTabBadges()   // refresh the per-tab counts
  let selected = sessions.find(s => sessionKey(s) === selectedKey) || null
  // While an embedded terminal is open, keep its session's detail panel alive even
  // if that session left the current tab's list — resuming a Closed session moves
  // it to Running, so it vanishes from the Closed list for a poll or two. Falling
  // back to the remembered session keeps the header (and its close controls) and
  // the terminal pane rendered until the user closes it (also survives a manual
  // tab switch, which nulls selectedKey).
  const termOpen = window.getTerminalVisible && window.getTerminalVisible()
  // The remembered terminal session is only a snapshot taken when the terminal
  // opened — re-resolve it from the freshly-fetched list every render so its
  // status dot (busy/waiting/idle) tracks the 5s poll instead of freezing on the
  // value it had at open time. Keyed by sessionKey, with a sessionId fallback
  // (a `--resume`d session keeps its id but runs under a new pid).
  if (window._terminalSession) {
    const pool = window._lastSessions || sessions
    const tKey = sessionKey(window._terminalSession)
    const tSid = window._terminalSession.sessionId
    const fresh = pool.find(s => sessionKey(s) === tKey) ||
                  (tSid ? pool.find(s => s.sessionId === tSid) : null)
    if (fresh) window._terminalSession = fresh
  }
  if (!selected && termOpen && window._terminalSession) selected = window._terminalSession
  renderDetailPanel(selected, tab)
  // The detail panel is INLINE in the list view — the only slide-over drawer left is
  // the board's, and that one is opened directly by openBoardDetail (never a renderAll
  // path). So any renderAll closes it: that's exactly how closeDrawer dismisses it.
  document.getElementById('panel-detail').classList.remove('open')
  document.getElementById('scrim').classList.remove('open')
}

// One delegated click handler on <body>, installed once. Because containers'
// innerHTML is rebuilt only when changed, per-element listeners would either be
// lost or duplicated; delegation is immune to that and keeps hover/cursor stable.
let delegationInstalled = false
// Warn before resuming a session that's already live. Offers "Reveal window" ONLY
// when we can actually locate its terminal window (canRevealTerminal pre-check),
// else just Cancel / Open anyway. proceed() runs the original open on "Open anyway".
async function warnAlreadyRunning(sid, body, proceed) {
  if (!window.confirmAction) { proceed(); return }
  const pid = window.sessionPidFor ? window.sessionPidFor(sid) : 0
  const canReveal = pid && window.api.canRevealTerminal ? await window.api.canRevealTerminal(pid) : false
  const choice = await window.confirmAction({
    title: '🚨 Session already running',
    body,
    confirmLabel: 'Open anyway',
    extraLabel: canReveal ? 'Reveal window' : null,
  })
  if (choice === 'extra') window.api.revealTerminal(pid)
  else if (choice === 'confirm') proceed()
}

// ── Resume / Restart routing (verb × destination) ──
// Shared by the detail-panel Option-A buttons, the Enter key, and the hover quick-
// actions on cards — all route through these so the "already running" guard and the
// embedded-vs-external split stay in one place.
// Resuming archived work un-archives it: strip the ARCHIVED marker so the session rejoins
// the live lifecycle (it lands in Closed/stale when it stops, instead of snapping straight
// back to Archived the moment its terminal dies). No-op when there's no marker;
// fire-and-forget so a failure never blocks the resume. Called from every resume path.
function unarchiveOnResume(notesPath) {
  if (notesPath && window.api && window.api.unarchiveSession) window.api.unarchiveSession(notesPath)
}

function routeResume(sid, cwd, notesPath) {
  unarchiveOnResume(notesPath)
  const dest = window.getOpenIn ? window.getOpenIn() : 'embedded'
  const liveKey = window.liveTerminalKeyFor ? window.liveTerminalKeyFor(sid, notesPath) : null
  if (dest === 'terminal') {
    const open = () => window.api.openInTerminal(cwd, sid)
    const live = (window.isSessionLive && window.isSessionLive(sid)) || !!liveKey
    if (live) warnAlreadyRunning(sid, `"${window.sessionNameFor(sid)}" is already running — opening it in your terminal starts a second instance on the same session.`, open)
    else open()
  } else if (window.toggleEmbeddedTerminal) {
    // Already has a live embedded terminal? Re-reveal it — never warn "already running"
    // or start a 2nd instance. liveTerminalKeyFor matches by notes.md (stable across the
    // sid changes a resume causes), so a backgrounded terminal keyed by an older sid is
    // still found — this is what used to miss and trip the warning.
    if (liveKey && window.openTerminalPane) {
      toListForEmbedded()
      window.openTerminalPane(liveKey, cwd || '')
      return
    }
    // First open: pass notesPath so the new terminal is tagged for future re-finds.
    const go = () => { toListForEmbedded(); window.toggleEmbeddedTerminal(sid, cwd, '', notesPath) }
    if (window.isSessionLive && window.isSessionLive(sid)) {
      warnAlreadyRunning(sid, `"${window.sessionNameFor(sid)}" is already running — opening it in the embedded terminal starts a second instance on the same session.`, go)
    } else { go() }
  }
}

// The key of this session's live embedded terminal, or null. A managed session resumed
// twice gets a fresh sessionId each time, but its notes.md is constant — so the most
// robust match is by notesPath (terminalKeyForNotes scans the entries' recorded notesPath,
// finding the terminal even when its Map key is an OLDER sid). Falls back to direct
// sessionId / notesPath key hits. Shared by routeResume + restoreTerminalForSelected.
function liveTerminalKeyFor(sid, notesPath) {
  const has = window.hasLiveTerminal
  if (!has) return null
  const s = (window._lastSessions || []).find(x => x.sessionId === sid)
  const np = notesPath || (s && s.notesPath)
  // Primary, sid-stable: a terminal tagged with this notes.md (any Map key).
  if (np && window.terminalKeyForNotes) {
    const k = window.terminalKeyForNotes(np)
    if (k) return k
  }
  if (sid && has(sid)) return sid
  return np && has(np) ? np : null
}
window.liveTerminalKeyFor = liveTerminalKeyFor
// The embedded terminal lives in the List view's detail panel — not the cramped
// board slide-over. So before opening it, leave any other view for List.
// (External-terminal resumes never call this — they open their own window.)
function toListForEmbedded() {
  if (window.viewMode && window.viewMode !== 'list' && window.setViewMode) window.setViewMode('list')
}
function routeRestart(slug, sid, cwd, notesPath) {
  const dest = window.getOpenIn ? window.getOpenIn() : 'embedded'
  if (dest === 'terminal') window.api.restoreSession(slug, sid)
  else if (window.toggleEmbeddedTerminal) {
    // Re-reveal an existing terminal for this notes.md if it's already live.
    const liveKey = window.liveTerminalKeyFor ? window.liveTerminalKeyFor(sid, notesPath) : null
    if (liveKey && window.openTerminalPane) { toListForEmbedded(); window.openTerminalPane(liveKey, cwd || ''); return }
    toListForEmbedded(); window.toggleEmbeddedTerminal(sid || slug, cwd, slug, notesPath)
  }
}
// Pick the right verb for a session (Resume when possible, else Restart from notes)
// and route per the destination pref. Used by Enter + hover quick-actions.
function openSessionDefault(s) {
  if (canResume(s)) { routeResume(s.sessionId, s.cwd || '', s.notesPath || ''); return true }
  const slug = slugOf(s)
  if (slug) { routeRestart(slug, s.sessionId || '', s.cwd || '', s.notesPath || ''); return true }
  return false
}
window.routeResume = routeResume
window.routeRestart = routeRestart
window.openSessionDefault = openSessionDefault
window.destinationToggle = destinationToggle   // reused by the +New modal (app.js)

function installDelegatedHandlers() {
  if (delegationInstalled) return
  delegationInstalled = true
  document.body.addEventListener('click', e => {
    // Anything carrying a data-url opens externally: the toolbar pills, the card's ticket
    // chip, and the reference links in the detail meta rows. Matching by class meant a new
    // link type silently did nothing when clicked, so match the attribute itself.
    const url = e.target.closest('[data-url]')
    if (url && url.dataset.url) {
      window.api.openExternal(url.dataset.url).then(res => {
        if (res && res.ok === false) console.warn(`could not open ${url.dataset.url}: ${res.error}`)
      })
      return
    }

    const infoBtn = e.target.closest('[data-info-pop]')
    if (infoBtn) {
      e.stopPropagation()
      if (document.getElementById('info-pop')) closeInfoPopover()   // re-click toggles closed
      else openInfoPopover(infoBtn)
      return
    }

    // Several PRs / tickets on one session → pick which to open (or edit the list).
    const linkMenuBtn = e.target.closest('[data-linkmenu]')
    if (linkMenuBtn) {
      e.stopPropagation()
      if (document.getElementById('link-menu')) { closeLinkMenu(); return }   // re-click toggles closed
      const s = (window._lastSessions || []).find(x => sessionKey(x) === linkMenuBtn.dataset.linkmenuKey)
      const menu = linkMenuFor(s, linkMenuBtn.dataset.linkmenu)
      if (menu && menu.items.length) openLinkMenu(linkMenuBtn, menu)
      return
    }

    const editRefs = e.target.closest('[data-edit-refs]')
    if (editRefs) {
      e.stopPropagation()
      openEditRefs(editRefs.dataset.editRefs)
      return
    }

    // ── Open actions (Option A) ──
    const destSeg = e.target.closest('[data-open-dest]')
    if (destSeg && window.setOpenIn) {
      window.setOpenIn(destSeg.dataset.openDest)
      // Reflect the pick on every visible destination toggle — the detail-panel one AND
      // the +New modal's (they share the csm.openIn pref).
      document.querySelectorAll('.open-dest').forEach(b =>
        b.classList.toggle('active', b.dataset.openDest === destSeg.dataset.openDest))
      const sel = (window._lastSessions || []).find(x => sessionKey(x) === window._lastSelectedKey)
      if (sel && window.renderDetailPanel) renderDetailPanel(sel, activeTab)   // refresh active segment + routing
      return
    }
    const resumeEl = e.target.closest('[data-open-resume]')
    if (resumeEl) {
      e.stopPropagation()
      routeResume(resumeEl.dataset.session, resumeEl.dataset.cwd || '', resumeEl.dataset.notes || '')
      return
    }
    const restartEl = e.target.closest('[data-open-restart]')
    if (restartEl) {
      e.stopPropagation()
      routeRestart(restartEl.dataset.restoreSlug, restartEl.dataset.restoreSid || '', restartEl.dataset.cwd || '', restartEl.dataset.notes || '')
      return
    }

    const iterm = e.target.closest('.pill[data-cwd]')
    if (iterm) {
      const sid = iterm.dataset.session
      const open = () => {
        unarchiveOnResume(iterm.dataset.notes || '')
        window.api.openInTerminal(iterm.dataset.cwd, sid)
      }
      // Already live (running, or we already hold an embedded terminal)? Opening
      // another instance attaches a second process to the same session — warn first.
      const live = (window.isSessionLive && window.isSessionLive(sid)) ||
                   (window.hasLiveTerminal && window.hasLiveTerminal(sid))
      if (live) {
        warnAlreadyRunning(sid, `"${window.sessionNameFor(sid)}" is already running — you likely have it open in a terminal. Resuming opens a second instance on the same session, which can clash.`, open)
      } else { open() }
      return
    }

    const folder = e.target.closest('[data-folder]')
    if (folder) { window.api.openPath(folder.dataset.folder); return }

    const reopen = e.target.closest('.pill[data-restore-slug]')
    if (reopen) { window.api.restoreSession(reopen.dataset.restoreSlug, reopen.dataset.restoreSid || ''); return }

    const term = e.target.closest('.terminal-toggle-btn')
    if (term && window.toggleEmbeddedTerminal) {
      const sid = term.dataset.session
      const notes = term.dataset.notes || ''
      const liveKey = window.liveTerminalKeyFor && window.liveTerminalKeyFor(sid, notes)
      // Already hold a terminal for this session (any key)? Reveal it; no new process.
      if (liveKey && window.openTerminalPane) { window.openTerminalPane(liveKey, term.dataset.cwd || ''); return }
      const go = () => {
        unarchiveOnResume(notes)
        window.toggleEmbeddedTerminal(sid, term.dataset.cwd, term.dataset.restartSlug || '', notes)
      }
      // Only warn when it's live elsewhere (running, not ours).
      const alreadyEmbedded = !!liveKey
      if (!alreadyEmbedded && window.isSessionLive && window.isSessionLive(sid)) {
        warnAlreadyRunning(sid, `"${window.sessionNameFor(sid)}" is already running — you likely have it open in a terminal. Opening it in the embedded terminal starts a second instance on the same session, which can clash.`, go)
      } else { go() }
      return
    }

    const detach = e.target.closest('.drawer-detach[data-key]')
    if (detach && window.detachSession) { window.detachSession(detach.dataset.key); return }

    // Pause — kill the embedded pty directly (no wrap-up, no close marker). The session
    // just goes idle (grey dot + age) and stays in Running, ready to Resume later.
    const pause = e.target.closest('.pause-btn[data-pause-sid], .pause-btn[data-pause-notes]')
    if (pause) {
      e.stopPropagation()
      const sid = pause.dataset.pauseSid || ''
      const notes = pause.dataset.pauseNotes || ''
      const liveKey = window.liveTerminalKeyFor && window.liveTerminalKeyFor(sid, notes)
      if (liveKey && window.killTerminal) {
        window.killTerminal(liveKey)
        if (window.refreshSessions) window.refreshSessions()
      }
      return
    }

    // Archive — confirm, then archive_session (moves Closed → Archived). Must come
    // before the card-select handler (it's inside a card); stopPropagation so the
    // card isn't selected by the same click.
    // Close (stale → Closed) — confirm, then stamp a close marker via close_session.
    const close = e.target.closest('.close-btn[data-close-notes]')
    if (close) {
      e.stopPropagation()
      const notes = close.dataset.closeNotes
      const name = close.dataset.closeName || 'this session'
      if (window.confirmAction && window.api.closeSession) {
        window.confirmAction({
          title: 'Close session',
          body: `Close "${name}"? It moves to the Closed tab. (No AI summary — for a full wrap-up, run /close-session in the session.)`,
          confirmLabel: 'Close',
        }).then(choice => {
          if (choice !== 'confirm') return
          window.api.closeSession(notes).then(res => {
            if (res && res.ok) {
              if (window.refreshSessions) window.refreshSessions()
            } else if (window.confirmAction) {
              window.confirmAction({ title: '⚠️ Close failed', body: (res && res.error) || 'unknown error', confirmLabel: 'OK' })
            }
          })
        })
      }
      return
    }

    const archive = e.target.closest('.archive-btn[data-archive-notes]')
    if (archive) {
      e.stopPropagation()
      const notes = archive.dataset.archiveNotes
      const name = archive.dataset.archiveName || 'this session'
      if (window.confirmAction) {
        window.confirmAction({
          title: 'Archive session',
          body: `Archive "${name}"? It moves to the Archived tab — you can bring it back later with Restart.`,
          confirmLabel: 'Archive',
        }).then(choice => {
          if (choice !== 'confirm') return
          window.api.archiveSession(notes).then(res => {
            if (res && res.ok) {
              if (window.refreshSessions) window.refreshSessions()
            } else if (window.confirmAction) {
              window.confirmAction({ title: '⚠️ Archive failed', body: (res && res.error) || 'unknown error', confirmLabel: 'OK' })
            }
          })
        })
      }
      return
    }

    // Delete (archived only) — confirm, then move the session folder to the macOS Trash.
    const del = e.target.closest('.delete-btn[data-delete-notes]')
    if (del) {
      e.stopPropagation()
      const notes = del.dataset.deleteNotes
      const name = del.dataset.deleteName || 'this session'
      const id = del.dataset.deleteId || ''
      if (window.confirmAction) {
        window.confirmAction({
          title: 'Move to Trash',
          body: `Move "${name}"${id ? ` (${id})` : ''} to the macOS Trash? This removes its session folder from disk — you can still restore it from the Finder.`,
          confirmLabel: 'Move to Trash',
        }).then(choice => {
          if (choice !== 'confirm') return
          window.api.deleteSession(notes).then(res => {
            if (res && res.ok) {
              if (window.refreshSessions) window.refreshSessions()
            } else if (window.confirmAction) {
              window.confirmAction({ title: '⚠️ Delete failed', body: (res && res.error) || 'unknown error', confirmLabel: 'OK' })
            }
          })
        })
      }
      return
    }

    // Open the board-column picker for the selected session (from the detail actions).
    const boardMenu = e.target.closest('[data-board-menu]')
    if (boardMenu && window.CSMBoard) {
      e.stopPropagation()
      if (document.getElementById('board-menu')) closeBoardMenu()   // re-click toggles closed
      else openBoardMenu(boardMenu, boardMenu.dataset.boardMenu)
      return
    }

    // Pin toggle — must come before the card-select handler (it's inside a card).
    const pin = e.target.closest('.pin-btn[data-pin-key]')
    if (pin && window.togglePin) { e.stopPropagation(); window.togglePin(pin.dataset.pinKey); return }

    const space = e.target.closest('.space-header[data-space]')
    if (space) {
      const sp = space.dataset.space
      const nowCollapsed = !collapsedSpaces.has(sp)
      if (nowCollapsed) collapsedSpaces.add(sp)
      else collapsedSpaces.delete(sp)
      const chevron = space.querySelector('.space-chevron')
      const sessionsEl = space.parentElement && space.parentElement.querySelector('.space-sessions')
      if (chevron) chevron.classList.toggle('collapsed', nowCollapsed)
      if (sessionsEl) sessionsEl.classList.toggle('collapsed', nowCollapsed)
      return
    }

    const cat = e.target.closest('.category-header[data-category]')
    if (cat) {
      const c = cat.dataset.category
      const nowCollapsed = !collapsedCategories.has(c)
      if (nowCollapsed) collapsedCategories.add(c)
      else collapsedCategories.delete(c)
      // Toggle the DOM directly instead of re-rendering: a re-render here would
      // redraw from the full (unfiltered) session list and flash a search/filter
      // mismatch. The Set keeps the next poll's full render in sync.
      const chevron = cat.querySelector('.category-chevron')
      const sessionsEl = cat.parentElement && cat.parentElement.querySelector('.category-sessions')
      if (chevron) chevron.classList.toggle('collapsed', nowCollapsed)
      if (sessionsEl) sessionsEl.classList.toggle('collapsed', nowCollapsed)
      return
    }

    const card = e.target.closest('.list-card[data-key]')
    if (card && window.selectSession) { window.selectSession(card.dataset.key); return }
  })
}

window.renderAll = renderAll
window.renderDetailPanel = renderDetailPanel
window.installDelegatedHandlers = installDelegatedHandlers
window.updateTabBadges = updateTabBadges
// Back-compat alias for the detached window
window.attachDetailEventListeners = installDelegatedHandlers
