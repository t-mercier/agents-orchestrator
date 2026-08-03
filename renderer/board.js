/* global CSMBoard */
// Kanban board renderer. Reads CSMBoard state + window._boardIndex (sessionKey ->
// live session). Browser-only (like ui.js); model logic lives in lib/board-model.js.
// Wrapped in an IIFE so its top-level names (escapeHtml, renderBoard, …) don't
// collide with ui.js's globals — classic <script>s share one lexical scope.
;(function () {
  const { escapeHtml } = window.CSMFormatters

  let boardState = null   // current CSMBoard state

  // Persist + re-render after any mutation.
  function applyBoard(next) {
    boardState = next
    CSMBoard.save(boardState)
    renderBoard()
  }

  // A small meta chip; category chips pick up the configured category colour.
  function chip(text, opts = {}) {
    const cm = (window.CSM_CONFIG && window.CSM_CONFIG.colorMap) || {}
    const color = opts.cat && /^#[0-9a-fA-F]{6}$/.test(cm[text] || '') ? ` style="color:${cm[text]}"` : ''
    return `<span class="kb-chip${opts.cat ? ' kb-chip-cat' : ''}"${color}>${escapeHtml(text)}</span>`
  }

  // Remove-from-board glyph (replaces the bare ✕ — a trash icon reads as "remove").
  const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>'
  const isUrgent = (id) => Array.isArray(boardState.urgent) && boardState.urgent.includes(id)
  function urgentBtn(id) {
    const on = isUrgent(id)
    return `<button class="kb-flag ${on ? 'on' : ''}" data-board-urgent="${escapeHtml(id)}" title="${on ? 'Unmark urgent' : 'Mark urgent'}">⚡</button>`
  }
  // Notes attached to a card or group (editable rows + a "＋ note" button). `col` is the
  // parent's column (where a new note is created), `parent` the card key or group id.
  function attachedNotesHtml(parent, col, addLabel) {
    const notes = CSMBoard.notesFor(boardState, parent)
    // No trash on an empty (in-creation) note — click away or Escape drops it.
    const rows = notes.map(n => `<div class="kb-cardnote">
      <span class="kb-cardnote-text" data-note-edit="${escapeHtml(n.id)}">${escapeHtml(n.text) || '<em>empty</em>'}</span>
      ${(n.text && n.text.trim()) ? `<button class="kb-x" data-board-remove-note="${escapeHtml(n.id)}" title="Delete note">${ICON_TRASH}</button>` : ''}
    </div>`).join('')
    return `<div class="kb-cardnotes">${rows}<button class="kb-add-cardnote" data-add-note-parent="${escapeHtml(parent)}" data-add-note-col="${escapeHtml(col || '')}">＋ ${escapeHtml(addLabel || 'note')}</button></div>`
  }

  function sessionCardHtml(key) {
    const s = (window._boardIndex || {})[key]
    if (!s) {
      return `<div class="kb-card kb-missing" data-kind="session" data-id="${escapeHtml(key)}">
        <div class="kb-card-top"><span class="kb-name">session unavailable</span>
        <button class="kb-x" data-board-remove-session="${escapeHtml(key)}" title="Remove from board">${ICON_TRASH}</button></div></div>`
    }
    // Dot reflects the lifecycle state: live status when active, else stale/closed/archived.
    const status = s.state === 'active' ? (s.status || 'idle') : (s.state || 'historical')
    const stateLabel = s.state === 'active' ? (s.status || 'idle') : (s.state || 'closed')
    const stale = s.state === 'stale'
    const waiting = s.state === 'active' && s.status === 'waiting'
    const urgent = isUrgent(key)
    const dotClass = stale ? 'stale' : status
    const next = (window.firstNextStep ? window.firstNextStep(s.nextSteps) : '') || ''
    const nextTrim = next.length > 64 ? next.slice(0, 63) + '…' : next
    const badges =
      (urgent ? '<span class="kb-badge urgent">⚡ urgent</span>' : '') +
      (waiting ? '<span class="kb-badge waiting">WAIT</span>' : (stale ? '<span class="kb-badge stale">idle</span>' : ''))
    // Ticket / PR as clickable service icons (open via the global .pill / data-url
    // handler; several PRs → a count badge + the picker popover, see ui.js prPill).
    const icons = [
      (window.prPill ? window.prPill(s) : ''),
    ].filter(Boolean).join('')
    // The board is the at-a-glance view, so show the ticket as a number chip (not a
    // bare icon). Clickable when a tracker URL is configured; a plain label otherwise.
    // Extra tickets ride a `+N` suffix, same as the list card.
    const tbase = (window.CSM_CONFIG && window.CSM_CONFIG.ticketBaseUrl) || ''
    const tickets = window.ticketsOf ? window.ticketsOf(s) : (s.ticket ? [s.ticket] : [])
    const tExtra = tickets.length > 1 ? `<span class="multi-suffix">+${tickets.length - 1}</span>` : ''
    const ticketChip = tickets.length
      ? (tbase
          ? `<button class="kb-chip kb-chip-ticket ticket-chip" data-url="${escapeHtml(tbase + tickets[0])}" data-tip="${escapeHtml(tickets.join(' · '))}">${escapeHtml(tickets[0])}${tExtra}</button>`
          : `<span class="kb-chip kb-chip-ticket" title="${escapeHtml(tickets.join(' · '))}">${escapeHtml(tickets[0])}${tExtra}</span>`)
      : ''
    // No per-card space chip on the board — the shared ⚲ Filter popover (Spaces
    // section) scopes it instead.
    const chips = [
      s.category ? chip(s.category, { cat: true }) : '',
      ticketChip,
    ].filter(Boolean).join('')
    const metaInner = chips + (icons ? `<span class="card-icons">${icons}</span>` : '')
    const cls = ['kb-card', escapeHtml(dotClass), urgent ? 'urgent' : '', waiting ? 'waiting' : ''].filter(Boolean).join(' ')
    // Title rides the top row on its own (full width, up to 2 lines) — the status
    // badges + action icons sit on a foot row so they never crowd the name.
    const footActs = urgentBtn(key) +
      `<button class="kb-goto" data-board-goto="${escapeHtml(key)}" title="Show in list">↗</button>` +
      `<button class="kb-x" data-board-remove-session="${escapeHtml(key)}" title="Remove from board">${ICON_TRASH}</button>`
    return `<div class="${cls}" data-kind="session" data-id="${escapeHtml(key)}">
      <div class="kb-card-top">
        <span class="kb-dot ${escapeHtml(dotClass)}" title="${escapeHtml(stateLabel)}"></span>
        <span class="kb-name" title="${escapeHtml(s.name || '')}">${escapeHtml(window.displayName ? window.displayName(s) : (s.name || 'unnamed'))}</span>
      </div>
      ${nextTrim ? `<div class="kb-next" title="Next: ${escapeHtml(next)}">↪ ${escapeHtml(nextTrim)}</div>` : ''}
      ${metaInner ? `<div class="kb-card-meta">${metaInner}</div>` : ''}
      <div class="kb-card-foot">${badges}<span class="kb-foot-acts">${footActs}</span></div>
      ${attachedNotesHtml(key, boardState.placements[key])}
    </div>`
  }

  function noteCardHtml(note) {
    const urgent = isUrgent(note.id)
    const cls = ['kb-card', 'kb-note', urgent ? 'urgent' : ''].filter(Boolean).join(' ')
    return `<div class="${cls}" data-kind="note" data-id="${escapeHtml(note.id)}">
      <div class="kb-card-top">
        <span class="kb-note-tag">note</span>
        <span class="kb-name kb-note-text" data-note-edit="${escapeHtml(note.id)}">${escapeHtml(note.text) || '<em>empty</em>'}</span>
        ${urgent ? '<span class="kb-badge urgent">⚡ urgent</span>' : ''}
        ${urgentBtn(note.id)}
        ${(note.text && note.text.trim()) ? `<button class="kb-x" data-board-remove-note="${escapeHtml(note.id)}" title="Delete note">${ICON_TRASH}</button>` : ''}
      </div>
    </div>`
  }

  // Category-filter visibility — the board mirrors the list/cards filter. A session is
  // hidden when its category isn't in the active filter; notes have no category so they
  // always show; a group shows when at least one of its members is visible.
  function visible(it) {
    if (it.kind === 'session') {
      const s = (window._boardIndex || {})[it.id]
      // Space + category filters come from the shared ⚲ Filter popover (Spaces section).
      const spaceOk = !window.passesSpaceFilter || window.passesSpaceFilter(s ? s.root : null)
      const catOk = !window.passesCatFilter || window.passesCatFilter(s ? s.category : null)
      const searchOk = !window.passesSearch || !s || window.passesSearch(s)
      return spaceOk && catOk && searchOk
    }
    if (it.kind === 'note') {
      const n = boardState.notes.find((x) => x.id === it.id)
      return !window.queryMatches || window.queryMatches(n ? n.text : '')
    }
    if (it.kind === 'group') return CSMBoard.orderedItems(boardState, 'g:' + it.id).some(visible)
    return true
  }
  function renderItem(it) {
    if (it.kind === 'group') return groupHtml(it.id)
    if (it.kind === 'note') { const n = boardState.notes.find(x => x.id === it.id); return n ? noteCardHtml(n) : '' }
    return sessionCardHtml(it.id)
  }
  function groupHtml(gid) {
    const g = boardState.groups.find(x => x.id === gid)
    if (!g) return ''
    const members = CSMBoard.orderedItems(boardState, 'g:' + gid).filter(visible)
    const inner = members.map(renderItem).join('')
    return `<div class="kb-group ${g.collapsed ? 'collapsed' : ''}" data-group="${escapeHtml(gid)}">
      <div class="kb-group-head">
        <button class="kb-group-chev" data-group-toggle="${escapeHtml(gid)}" title="Collapse / expand">▾</button>
        <span class="kb-group-name" data-group-rename="${escapeHtml(gid)}" title="Rename group">${escapeHtml(g.name)}</span>
        <span class="kb-group-n">${members.length}</span>
        <button class="kb-group-x" data-group-ungroup="${escapeHtml(gid)}" title="Ungroup">⊟</button>
      </div>
      <div class="kb-group-body" data-group-drop="${escapeHtml(gid)}">${inner}${attachedNotesHtml(gid, g.columnId, 'note to group')}</div>
    </div>`
  }
  // Per-column accent: each column scopes --accent to its own colour, so accent-tinted
  // bits inside it (＋ buttons, urgent bar, focus ring, group frame, next cue) take the
  // column's colour — a clear per-column identity. Falls back to the global accent.
  // (rgb triplet + legible on-accent text reuse app.js's shared hexToRgbTriplet/onAccentText.)

  function columnHtml(col, index, total) {
    // Render in the column's manual order (urgent is now a highlight, not auto-float —
    // priority is set by dragging cards up/down).
    const items = CSMBoard.orderedItems(boardState, col.id).filter(visible)
    const count = items.length
    const cards = count === 0
      ? `<button class="kb-empty" data-add-session="${escapeHtml(col.id)}">＋ Add a session</button>`
      : items.map(renderItem).join('')
    // Effective colour: the column's own .color wins, else the generative seed+scheme.
    // Guard to a strict hex here too (belt-and-suspenders) before it's inlined into a
    // style="" attribute — never trust it could carry a quote and break out.
    const raw = CSMBoard.colorForColumn(boardState, col, index || 0, total || 1)
    const color = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : ''
    const titleStyle = color ? ` style="color:${color}"` : ''
    const barStyle = ` style="border-top-color:${color || 'transparent'}"`
    // Only offer delete when there's more than one column (the model has no last-column
    // guard — removing the only column would leave the board empty).
    const del = boardState.columns.length > 1
      ? `<button class="kb-col-del" data-col-del="${escapeHtml(col.id)}" title="Delete column (cards move to the first column)">✕</button>`
      : ''
    const colStyle = color ? ` style="--accent:${color};--accent-rgb:${hexToRgbTriplet(color)};--on-accent:${onAccentText(color)}"` : ''
    return `<div class="kb-col"${colStyle} data-col="${escapeHtml(col.id)}">
      <div class="kb-col-head">
        <span class="kb-col-name" data-col-rename="${escapeHtml(col.id)}" title="Click to rename"${titleStyle}>${escapeHtml(col.name)}</span>
        <span class="kb-col-n">${count}</span>
        ${del}
      </div>
      <div class="kb-col-body" data-col-drop="${escapeHtml(col.id)}"${barStyle}>${cards}
        <div class="kb-col-foot">
          <button class="kb-add-btn" data-add-session="${escapeHtml(col.id)}">＋ session</button>
          <button class="kb-add-btn" data-add-note="${escapeHtml(col.id)}">＋ note</button>
        </div>
      </div>
    </div>`
  }

  function renderBoard() {
    const host = document.getElementById('board-view')
    if (!host) return
    // Never rebuild the DOM out from under an open inline editor (column / group
    // rename, note edit). The 5s poll calls renderBoard, and replacing innerHTML mid-
    // typing destroyed the focused input — focus lost + uncommitted text gone after a
    // couple of keystrokes. On commit (blur/Enter) focus has already left the input,
    // so that re-render still goes through.
    const ae = document.activeElement
    if (ae && host.contains(ae) && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
    boardState = CSMBoard.load()
    const visible = boardState.columns.filter(c => !c.hidden)
    const cols = visible.map((c, i) => columnHtml(c, i, visible.length)).join('')
    host.innerHTML = `<div class="kb-board">${cols}<button class="kb-add-col" id="kb-add-col" title="Add a column">＋</button></div>`
    installBoardHandlers()
    applyBoardFocus()   // re-apply the keyboard focus ring after a re-render
  }

  // Inline edit: swap a span for an input. Enter/blur commits, Escape cancels.
  // commit(text) and cancel() each return the next board state, or null to just
  // repaint (revert). NB: renderBoard() bails while an input is focused (the poll
  // guard), so we blur the input BEFORE re-rendering — else a cancel wouldn't paint.
  function inlineEdit(span, value, opts) {
    const input = document.createElement('input')
    input.className = opts.className || 'kb-note-input'
    input.value = value
    span.replaceWith(input)
    input.focus()
    if (opts.select) input.select()
    let settled = false
    const settle = (next) => {
      if (settled) return
      settled = true
      if (document.activeElement === input) input.blur()
      if (next) applyBoard(next)
      else renderBoard()
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); settle(opts.commit(input.value)) }
      else if (e.key === 'Escape') { e.preventDefault(); settle(opts.cancel()) }
    })
    input.addEventListener('blur', () => settle(opts.commit(input.value)))
  }

  // Inline note editing — empty text drops the note (no orphaned empties); Escape on
  // a fresh empty note also drops it, on an existing one reverts.
  function startNoteEdit(span) {
    const id = span.dataset.noteEdit
    const current = (CSMBoard.load().notes.find(n => n.id === id) || {}).text || ''
    inlineEdit(span, current, {
      className: 'kb-note-input',
      commit: (t) => t.trim() ? CSMBoard.updateNote(CSMBoard.load(), id, t.trim()) : CSMBoard.removeNote(CSMBoard.load(), id),
      cancel: () => current.trim() ? null : CSMBoard.removeNote(CSMBoard.load(), id),
    })
  }

  // Inline column rename — empty keeps the old name.
  function startColumnRename(span) {
    const id = span.dataset.colRename
    const current = (CSMBoard.load().columns.find(c => c.id === id) || {}).name || ''
    inlineEdit(span, current, {
      className: 'kb-col-name-input', select: true,
      commit: (t) => t.trim() ? CSMBoard.renameColumn(CSMBoard.load(), id, t.trim()) : null,
      cancel: () => null,
    })
  }

  // Inline group rename — empty keeps the old name.
  function startGroupRename(span) {
    const id = span.dataset.groupRename
    const current = (CSMBoard.load().groups.find(g => g.id === id) || {}).name || ''
    inlineEdit(span, current, {
      className: 'kb-col-name-input', select: true,
      commit: (t) => t.trim() ? CSMBoard.renameGroup(CSMBoard.load(), id, t.trim()) : null,
      cancel: () => null,
    })
  }

  // Add-session picker: lists sessions not yet on the board; click places one in the column.
  let addMenuOutside = null
  function closeAddMenu() {
    const m = document.getElementById('add-session-menu'); if (m) m.remove()
    if (addMenuOutside) { document.removeEventListener('click', addMenuOutside, true); addMenuOutside = null }
  }
  function openAddSessionMenu(anchor, columnId) {
    closeAddMenu()
    const idx = window._boardIndex || {}
    const placed = new Set(Object.keys(boardState.placements))
    const entries = Object.entries(idx).filter(([k]) => !placed.has(k))
    const dn = (s) => (window.displayName ? window.displayName(s) : (s.name || 'unnamed'))
    const items = entries.length
      ? entries.map(([k, s]) => `<button class="board-menu-item" data-add-place="${escapeHtml(k)}">
          <span class="kb-dot ${escapeHtml(s.status || s.state || 'idle')}"></span>
          <span class="board-menu-name">${escapeHtml(dn(s))}</span>
          ${s.category ? `<span class="board-menu-cat">${escapeHtml(s.category)}</span>` : ''}
        </button>`).join('')
      : '<div class="board-menu-empty">All sessions are already on the board</div>'
    const menu = document.createElement('div')
    menu.className = 'board-menu'
    menu.id = 'add-session-menu'
    menu.dataset.col = columnId   // so a re-click on this column's ＋ session toggles it closed
    const searchBox = entries.length
      ? '<input class="board-menu-search" type="text" placeholder="Filter sessions…" spellcheck="false" autocomplete="off">'
      : ''
    menu.innerHTML = `<div class="board-menu-head">Add a session</div>${searchBox}<div class="board-menu-items">${items}</div>`
    document.body.appendChild(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`
    // Type-to-filter: focus the box on open so you can search by keyboard immediately;
    // Enter places the first still-visible match, Esc closes.
    const search = menu.querySelector('.board-menu-search')
    if (search) {
      search.focus()
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase()
        menu.querySelectorAll('.board-menu-item[data-add-place]').forEach((b) => {
          const name = (b.querySelector('.board-menu-name')?.textContent || '').toLowerCase()
          const cat = (b.querySelector('.board-menu-cat')?.textContent || '').toLowerCase()
          b.style.display = !q || name.includes(q) || cat.includes(q) ? '' : 'none'
        })
      })
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeAddMenu(); return }
        if (e.key === 'Enter') {
          const first = [...menu.querySelectorAll('.board-menu-item[data-add-place]')].find((b) => b.style.display !== 'none')
          if (first) { e.preventDefault(); applyBoard(CSMBoard.placeSession(CSMBoard.load(), first.dataset.addPlace, columnId)); closeAddMenu() }
        }
      })
    }
    menu.addEventListener('click', (e) => {
      const it = e.target.closest('[data-add-place]')
      if (it) { applyBoard(CSMBoard.placeSession(CSMBoard.load(), it.dataset.addPlace, columnId)); closeAddMenu() }
    })
    addMenuOutside = (e) => { if (!e.target.closest('#add-session-menu') && !e.target.closest('[data-add-session]')) closeAddMenu() }
    setTimeout(() => document.addEventListener('click', addMenuOutside, true), 0)
  }

  let boardHandlersInstalled = false
  let suppressClick = false   // set after a real drag, to swallow the trailing click
  function installBoardHandlers() {
    if (boardHandlersInstalled) return
    boardHandlersInstalled = true
    const host = document.getElementById('board-view')
    if (!host) return

    host.addEventListener('click', (e) => {
      // A real drag just ended on this card → swallow the trailing click so it
      // doesn't also trigger note-edit / select.
      if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); return }
      const addCol = e.target.closest('#kb-add-col')
      if (addCol) {
        applyBoard(CSMBoard.addColumn(CSMBoard.load(), 'New column'))
        const cols = host.querySelectorAll('[data-col-rename]')
        if (cols.length) startColumnRename(cols[cols.length - 1])
        return
      }
      const delCol = e.target.closest('[data-col-del]')
      if (delCol) {
        const id = delCol.dataset.colDel
        const col = CSMBoard.load().columns.find(c => c.id === id) || {}
        const doDel = () => applyBoard(CSMBoard.removeColumn(CSMBoard.load(), id))
        if (window.confirmAction) {
          window.confirmAction({
            title: 'Delete column',
            body: `Delete "${col.name || 'column'}"? Its cards move to the first column.`,
            confirmLabel: 'Delete',
          }).then(c => { if (c === 'confirm') doDel() })
        } else { doDel() }
        return
      }
      const renameCol = e.target.closest('[data-col-rename]')
      if (renameCol) { startColumnRename(renameCol); return }
      const addNote = e.target.closest('[data-add-note]')
      if (addNote) {
        const col = addNote.dataset.addNote
        applyBoard(CSMBoard.addNote(CSMBoard.load(), col, ''))
        const body = host.querySelector(`[data-col-drop="${CSS.escape(col)}"]`)
        const notes = body ? body.querySelectorAll('[data-note-edit]') : []
        if (notes.length) startNoteEdit(notes[notes.length - 1])
        return
      }
      const addSess = e.target.closest('[data-add-session]')
      if (addSess) {
        const open = document.getElementById('add-session-menu')
        if (open && open.dataset.col === addSess.dataset.addSession) closeAddMenu()   // re-click closes
        else openAddSessionMenu(addSess, addSess.dataset.addSession)
        return
      }
      const addCN = e.target.closest('[data-add-note-parent]')
      if (addCN) {
        const parent = addCN.dataset.addNoteParent
        const next = CSMBoard.addNote(CSMBoard.load(), addCN.dataset.addNoteCol, '', parent)
        applyBoard(next)
        const notes = CSMBoard.notesFor(next, parent)
        const id = notes.length ? notes[notes.length - 1].id : null
        if (id) { const span = host.querySelector(`[data-note-edit="${CSS.escape(id)}"]`); if (span) startNoteEdit(span) }
        return
      }
      const rmNote = e.target.closest('[data-board-remove-note]')
      if (rmNote) { applyBoard(CSMBoard.removeNote(CSMBoard.load(), rmNote.dataset.boardRemoveNote)); return }
      const rmSession = e.target.closest('[data-board-remove-session]')
      if (rmSession) { applyBoard(CSMBoard.unplaceSession(CSMBoard.load(), rmSession.dataset.boardRemoveSession)); return }
      const urg = e.target.closest('[data-board-urgent]')
      if (urg) { applyBoard(CSMBoard.toggleUrgent(CSMBoard.load(), urg.dataset.boardUrgent)); return }
      const gTog = e.target.closest('[data-group-toggle]')
      if (gTog) {
        const g = boardState.groups.find(x => x.id === gTog.dataset.groupToggle)
        applyBoard(CSMBoard.setGroupCollapsed(CSMBoard.load(), gTog.dataset.groupToggle, !(g && g.collapsed)))
        return
      }
      const gUn = e.target.closest('[data-group-ungroup]')
      if (gUn) { applyBoard(CSMBoard.ungroup(CSMBoard.load(), gUn.dataset.groupUngroup)); return }
      const gRen = e.target.closest('[data-group-rename]')
      if (gRen) { startGroupRename(gRen); return }
      const goto = e.target.closest('[data-board-goto]')
      if (goto) { if (window.goToSession) window.goToSession(goto.dataset.boardGoto); return }
      const editNote = e.target.closest('[data-note-edit]')
      if (editNote) { startNoteEdit(editNote); return }
      // A plain click on a session card → open its detail in the slide-over (stay on the
      // board). Buttons/icons above already returned; guard the ticket/PR pills too.
      const sessCard = e.target.closest('.kb-card[data-kind="session"]')
      if (sessCard && !e.target.closest('.card-icons') && window.openBoardDetail) {
        window.openBoardDetail(sessCard.dataset.id); return
      }
    })

    // ── Drag between columns (pointer-based) ──
    // WKWebView's native HTML5 drag-and-drop is unreliable (drop often never fires),
    // so we drive it with mouse events: a floating ghost follows the cursor and we
    // resolve the target column via elementFromPoint. A small move threshold keeps
    // plain clicks (note-edit / remove) working.
    const THRESHOLD = 5
    let drag = null      // { kind, id, card, active, ghost, dropCol, dropIndex, ... }
    let insEl = null     // floating insertion line (overlay — no layout shift)
    function clearIns() { if (insEl) insEl.style.display = 'none' }
    function clearMerge() { host.querySelectorAll('.kb-merge').forEach(el => el.classList.remove('kb-merge')) }
    // Resolve a drop at (x,y):
    //  - { type:'merge', card }            → over the middle of a top-level card → group them
    //  - { type:'insert', container, key, isGroup, index, items } → drop at a position in a
    //    column body or a group body
    function dropTarget(x, y) {
      const el = document.elementFromPoint(x, y)
      if (!el || !el.closest) return null
      const groupBody = el.closest('[data-group-drop]')
      const colBody = el.closest('[data-col-drop]')
      // Merge: over the middle band of a card that is NOT inside a group body.
      if (!groupBody) {
        const card = el.closest('.kb-card')
        if (card && !card.classList.contains('dragging')) {
          const r = card.getBoundingClientRect()
          const rel = (y - r.top) / r.height
          if (rel > 0.28 && rel < 0.72) return { type: 'merge', card }
        }
      }
      const container = groupBody || colBody
      if (!container) return null
      const sel = groupBody ? ':scope > .kb-card' : ':scope > .kb-card, :scope > .kb-group'
      const items = [...container.querySelectorAll(sel)].filter(c => !c.classList.contains('dragging'))
      let index = items.length
      for (let k = 0; k < items.length; k++) {
        const r = items[k].getBoundingClientRect()
        if (y < r.top + r.height / 2) { index = k; break }
      }
      return { type: 'insert', container, key: groupBody ? groupBody.dataset.groupDrop : colBody.dataset.colDrop, isGroup: !!groupBody, index, items }
    }
    function showIns(t) {
      if (!insEl) { insEl = document.createElement('div'); insEl.className = 'kb-ins'; document.body.appendChild(insEl) }
      const br = t.container.getBoundingClientRect()
      let y
      if (t.items[t.index]) y = t.items[t.index].getBoundingClientRect().top - 4
      else if (t.items.length) y = t.items[t.items.length - 1].getBoundingClientRect().bottom + 4
      else y = br.top + 6
      insEl.style.left = `${br.left + 6}px`
      insEl.style.width = `${br.width - 12}px`
      insEl.style.top = `${Math.round(y)}px`
      insEl.style.display = 'block'
    }

    host.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      // Fresh interaction: clear any stale click-suppression. Guards the edge where a
      // drag ended off-board (no trailing board click fired to reset it) → otherwise the
      // next legit click would be wrongly swallowed.
      suppressClick = false
      // Group header → drag the whole group as a unit (but not its chevron/name/ungroup).
      const ghead = e.target.closest('.kb-group-head')
      if (ghead && !e.target.closest('.kb-group-chev, .kb-group-name, .kb-group-x')) {
        e.preventDefault()
        const groupEl = ghead.closest('.kb-group')
        drag = { isGroup: true, gid: groupEl.dataset.group, card: groupEl, x: e.clientX, y: e.clientY, active: false, ghost: null }
        return
      }
      const card = e.target.closest('.kb-card')
      // Don't start a drag from the remove ✕ or an active note input.
      if (!card || e.target.closest('.kb-x, .kb-goto, .kb-flag, .archive-btn, .card-icons, .kb-note-input, .kb-cardnote, .kb-add-cardnote')) return
      e.preventDefault()   // stop the browser starting a text selection during the drag
      const fromBody = card.closest('[data-col-drop]')
      drag = { kind: card.dataset.kind, id: card.dataset.id, card, x: e.clientX, y: e.clientY,
               active: false, ghost: null, fromCol: fromBody ? fromBody.dataset.colDrop : null }
    })

    document.addEventListener('mousemove', (e) => {
      if (!drag) return
      if (!drag.active) {
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < THRESHOLD) return
        drag.active = true
        drag.card.classList.add('dragging')
        const r = drag.card.getBoundingClientRect()
        drag.offX = e.clientX - r.left
        drag.offY = e.clientY - r.top
        const ghost = drag.card.cloneNode(true)
        ghost.classList.add('kb-ghost')
        ghost.style.width = `${r.width}px`
        drag.ghost = ghost
        document.body.appendChild(ghost)
        document.body.classList.add('kb-dragging')
      }
      drag.ghost.style.left = `${e.clientX - drag.offX}px`
      drag.ghost.style.top = `${e.clientY - drag.offY}px`
      const t = dropTarget(e.clientX, e.clientY)
      clearMerge()
      if (drag.isGroup) {
        // A group moves as a unit: only a position in a column is valid (no merge/nesting).
        if (t && t.type === 'insert' && !t.isGroup) { showIns(t); drag.drop = t }
        else { clearIns(); drag.drop = null }
      } else if (t && t.type === 'merge') { clearIns(); t.card.classList.add('kb-merge'); drag.drop = t }
      else if (t) { showIns(t); drag.drop = t }
      else { clearIns(); drag.drop = null }
    })

    document.addEventListener('mouseup', (e) => {
      if (!drag) return
      const d = drag
      drag = null
      if (d.ghost) d.ghost.remove()
      if (d.card) d.card.classList.remove('dragging')
      document.body.classList.remove('kb-dragging')
      clearIns(); clearMerge()
      if (!d.active) return          // it was a click, not a drag
      suppressClick = true           // eat the click that follows this mouseup
      const t = d.drop
      if (!t) return
      const load = CSMBoard.load()
      if (d.isGroup) {
        if (t.type === 'insert' && !t.isGroup) applyBoard(CSMBoard.moveGroup(load, d.gid, t.key, t.index))
        return
      }
      if (t.type === 'merge') {
        const targetId = t.card.dataset.id
        if (targetId === d.id) return
        const gid = CSMBoard.findGroupOf(load, targetId)
        if (gid) { applyBoard(CSMBoard.addToGroup(load, gid, d.id)); return }   // add to target's group
        const colBody = t.card.closest('[data-col-drop]')
        if (!colBody) return
        const tops = [...colBody.querySelectorAll(':scope > .kb-card, :scope > .kb-group')]
        const at = tops.indexOf(t.card)
        applyBoard(CSMBoard.createGroup(load, colBody.dataset.colDrop, [targetId, d.id], 'Group', at < 0 ? undefined : at))
        return
      }
      // insert at a position in a group body or a column body
      if (t.isGroup) applyBoard(CSMBoard.addToGroup(load, t.key, d.id, t.index))
      else applyBoard(CSMBoard.moveItem(load, d.kind, d.id, t.key, t.index))
    })
  }

  // ── Keyboard navigation on the board (2D) ──
  let boardFocus = null   // data-id of the focused card
  function boardColumns() {
    const host = document.getElementById('board-view')
    if (!host) return []
    return [...host.querySelectorAll('.kb-col')].map(col => [...col.querySelectorAll('.kb-card[data-id]')])
  }
  function applyBoardFocus() {
    const host = document.getElementById('board-view'); if (!host) return
    host.querySelectorAll('.kb-card.kb-focus').forEach(el => el.classList.remove('kb-focus'))
    if (!boardFocus) return
    const el = host.querySelector(`.kb-card[data-id="${CSS.escape(boardFocus)}"]`)
    if (el) { el.classList.add('kb-focus'); el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }
  }
  function findFocus(cols) {
    for (let c = 0; c < cols.length; c++) {
      const r = cols[c].findIndex(card => card.dataset.id === boardFocus)
      if (r >= 0) return { c, r }
    }
    return null
  }
  function boardNav(dir) {
    const cols = boardColumns()
    if (!cols.length) return
    let pos = findFocus(cols)
    if (!pos) {   // no focus yet → first non-empty column's first card
      for (let c = 0; c < cols.length; c++) if (cols[c].length) { boardFocus = cols[c][0].dataset.id; applyBoardFocus(); return }
      return
    }
    let { c, r } = pos
    if (dir === 'down') r = Math.min(cols[c].length - 1, r + 1)
    else if (dir === 'up') r = Math.max(0, r - 1)
    else {   // left / right — skip empty columns, clamp the row
      const step = dir === 'right' ? 1 : -1
      let nc = c + step
      while (nc >= 0 && nc < cols.length && !cols[nc].length) nc += step
      if (nc < 0 || nc >= cols.length) return
      c = nc; r = Math.min(r, cols[c].length - 1)
    }
    const target = cols[c][r]
    if (target) { boardFocus = target.dataset.id; applyBoardFocus() }
  }
  function boardOpenFocused() {
    if (!boardFocus) return
    const host = document.getElementById('board-view')
    const el = host && host.querySelector(`.kb-card[data-id="${CSS.escape(boardFocus)}"]`)
    if (el && el.dataset.kind === 'session' && window.openBoardDetail) window.openBoardDetail(boardFocus)
  }
  window.boardNav = boardNav
  window.boardOpenFocused = boardOpenFocused
  window.renderBoard = renderBoard
  window.applyBoard = applyBoard
})()
