// Settings: Board tab — seed/scheme for Kanban columns, columns editor.
// All live-only: apply immediately via CSMBoard and revert via snapshot on Cancel.
;(function () {
  const modal = document.getElementById('settings-modal')
  if (!modal) return
  const colList = document.getElementById('set-col-list')
  const $ = (id) => document.getElementById(id)

  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>'

  function refreshBoardIfOpen() {
    if (window.viewMode === 'board' && window.renderBoard) window.renderBoard()
  }

  function renderColRows() {
    if (!colList || !window.CSMBoard) return
    const st = CSMBoard.load()
    const visible = st.columns.filter(c => !c.hidden)
    colList.innerHTML = st.columns.map((c, i) => {
      // Show the EFFECTIVE colour (manual override, else scheme-derived) so the pastilles
      // preview the scheme live; index matches the board's visible-column order.
      const eff = CSMBoard.colorForColumn(st, c, Math.max(0, visible.indexOf(c)), visible.length)
      const val = /^#[0-9a-fA-F]{6}$/.test(eff) ? eff : window.CSM_COLORS.neutral
      return `
      <div class="settings-col-row ${c.hidden ? 'col-hidden' : ''}" data-col-id="${c.id}">
        <input class="col-color" type="color" value="${val}" title="Column colour (overrides the scheme)">
        <input class="col-name" type="text" value="${(c.name || '').replace(/"/g, '&quot;')}" maxlength="40" spellcheck="false">
        <button type="button" class="icon-btn col-hide" title="${c.hidden ? 'Show on board' : 'Hide from board'}">${c.hidden ? EYE_OFF : EYE}</button>
        <button type="button" class="icon-btn col-up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="icon-btn col-down" title="Move down" ${i === st.columns.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="icon-btn col-del" title="Remove (cards move to the first column)">✕</button>
      </div>`
    }).join('')
  }

  // ── Board column colours: a seed (reuses the Look swatches) + a scheme ──
  function renderBoardSeed() {
    const grid = $('set-board-seed')
    if (!grid || !window.CSM_LOOKS || !window.CSM_LOOK_CARDS || !window.CSMBoard) return
    const st = CSMBoard.load()
    const seed = (st.colorSeed || '').toLowerCase()
    const matchesLook = window.CSM_LOOKS.some(L => L.accent.toLowerCase() === seed)
    // Shared with Appearance and Category colours (CSM_LOOK_CARDS): this panel used to
    // draw flat colour blocks of its own, which is the whole reason it read as a
    // different app.
    grid.innerHTML = window.CSM_LOOK_CARDS({
      attr: 'seed', valueOf: (L) => L.accent, none: true, customInputClass: 'seed-custom-input',
    })
    const cv = (seed && !matchesLook) ? st.colorSeed : window.CSM_COLORS.accent
    const customInput = grid.querySelector('.seed-custom-input')
    if (customInput) customInput.value = cv
    grid.querySelectorAll('.look-card').forEach(b => {
      const v = b.dataset.seed
      const active = v === '' ? !seed : v === 'custom' ? (!!seed && !matchesLook) : v.toLowerCase() === seed
      b.classList.toggle('active', active)
    })
    const scheme = st.colorScheme || 'spectrum'
    document.querySelectorAll('.scheme-toggle [data-scheme]').forEach(b => b.classList.toggle('active', b.dataset.scheme === scheme))
  }
  function applyBoardSeed(seed) {
    const cur = CSMBoard.load()
    let st = CSMBoard.setColorScheme(cur, seed, cur.colorScheme)
    // Picking a seed colour re-applies the scheme to ALL columns (clears prior manual
    // colours); you can then re-override individual columns. (None keeps manual colours.)
    if (seed) st = CSMBoard.clearColumnColors(st)
    CSMBoard.save(st)
    renderBoardSeed(); renderColRows(); refreshBoardIfOpen()
  }

  // Populate board controls from live state.
  function populateBoard() {
    renderBoardSeed()
    renderColRows()
  }

  // Register populate only (live-only tab).
  window.CSMSettings.register({
    populate: populateBoard,
  })

  const seedGrid = $('set-board-seed')
  if (seedGrid) {
    // Preset/None → apply directly. Custom = the embedded <input type=color> handles itself.
    seedGrid.addEventListener('click', (e) => {
      const b = e.target.closest('.look-card'); if (!b || b.dataset.seed === 'custom') return
      applyBoardSeed(b.dataset.seed)
    })
    seedGrid.addEventListener('input', (e) => {
      if (e.target.classList.contains('seed-custom-input')) applyBoardSeed(e.target.value)
    })
  }
  document.querySelectorAll('.scheme-toggle [data-scheme]').forEach(btn => btn.addEventListener('click', () => {
    const st = CSMBoard.load()
    CSMBoard.save(CSMBoard.setColorScheme(st, st.colorSeed, btn.dataset.scheme))
    renderBoardSeed(); renderColRows(); refreshBoardIfOpen()
  }))

  // Kanban columns — live edits (reorder / remove / add), persisted via CSMBoard.
  if (colList) {
    colList.addEventListener('click', (e) => {
      const row = e.target.closest('.settings-col-row'); if (!row) return
      const id = row.dataset.colId
      if (e.target.closest('.col-del')) CSMBoard.save(CSMBoard.removeColumn(CSMBoard.load(), id))
      else if (e.target.closest('.col-hide')) {
        const col = CSMBoard.load().columns.find(c => c.id === id)
        CSMBoard.save(CSMBoard.setColumnHidden(CSMBoard.load(), id, !(col && col.hidden)))
      }
      else if (e.target.closest('.col-up')) CSMBoard.save(CSMBoard.moveColumn(CSMBoard.load(), id, -1))
      else if (e.target.closest('.col-down')) CSMBoard.save(CSMBoard.moveColumn(CSMBoard.load(), id, 1))
      else return
      renderColRows(); refreshBoardIfOpen()
    })
    colList.addEventListener('change', (e) => {
      const row = e.target.closest('.settings-col-row'); if (!row) return
      const id = row.dataset.colId
      if (e.target.closest('.col-name')) CSMBoard.save(CSMBoard.renameColumn(CSMBoard.load(), id, e.target.value))
      else if (e.target.closest('.col-color')) CSMBoard.save(CSMBoard.setColumnColor(CSMBoard.load(), id, e.target.value))
      else return
      refreshBoardIfOpen()
    })
    $('set-add-col').addEventListener('click', () => {
      CSMBoard.save(CSMBoard.addColumn(CSMBoard.load(), 'New column')); renderColRows(); refreshBoardIfOpen()
    })
  }
})()
