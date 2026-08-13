// Settings: Appearance tab — theme, looks, accent, compact chrome, density.
// All live-only: apply immediately via window.* and revert via snapshot on Cancel.
;(function () {
  const modal = document.getElementById('settings-modal')
  if (!modal) return
  const $ = (id) => document.getElementById(id)

  // ── Looks (Settings → Appearance) ──
  // A look = accent + a faint surface tint. Applies LIVE and reverts on Cancel via the
  // snapshot. Category chip colours are untouched (looks are ambiance, not a recolour).
  function renderLooks() {
    const grid = $('look-grid')
    if (!grid || !window.CSM_LOOKS || !window.CSM_LOOK_CARDS) return
    grid.innerHTML = window.CSM_LOOK_CARDS({ attr: 'look', valueOf: (L) => L.id })
  }
  function highlightActiveLook(id) {
    const grid = $('look-grid')
    if (!grid) return
    grid.querySelectorAll('.look-card').forEach(b => b.classList.toggle('active', b.dataset.look === id))
  }
  function applyLookById(id) {
    if (id === 'custom') {
      // Keep the current accent, drop the tint, and open the picker to choose a colour.
      const acc = (window.getAccent ? window.getAccent() : window.CSM_COLORS.accent)
      if (window.applyLook) window.applyLook(acc, '0,0,0', 0, 'custom')
      highlightActiveLook('custom')
      const inp = $('set-accent'); if (inp) { inp.value = acc; inp.focus(); if (inp.showPicker) { try { inp.showPicker() } catch {} } }
      return
    }
    const L = (window.CSM_LOOKS || []).find(x => x.id === id)
    if (!L) return
    if (window.applyLook) window.applyLook(L.accent, L.tint, L.tintA, L.id)
    if ($('set-accent')) $('set-accent').value = L.accent
    highlightActiveLook(id)
  }

  // Populate appearance controls from live state.
  function populateAppearance() {
    const theme = window.getTheme ? window.getTheme() : 'dark'
    document.querySelectorAll('.theme-toggle [data-theme-choice]').forEach(b =>
      b.classList.toggle('active', b.dataset.themeChoice === theme))
    if (window.getAccent) $('set-accent').value = window.getAccent()
    const density = window.getDensity ? window.getDensity() : 'detailed'
    document.querySelectorAll('[data-density-choice]').forEach(b =>
      b.classList.toggle('active', b.dataset.densityChoice === density))
    renderLooks()
    highlightActiveLook(window.getLook ? window.getLook().id : 'ardoise')
    const compact = window.getCompactChrome ? window.getCompactChrome() : false
    document.querySelectorAll('.compact-toggle [data-compact-choice]').forEach(b =>
      b.classList.toggle('active', (b.dataset.compactChoice === '1') === compact))
  }

  // Register populate only (live-only tab, no collect/validate).
  window.CSMSettings.register({
    populate: populateAppearance,
  })

  // Appearance — apply live + persist (localStorage), independent of Save/Cancel.
  document.querySelectorAll('.theme-toggle [data-theme-choice]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.applyTheme) window.applyTheme(btn.dataset.themeChoice)
      document.querySelectorAll('.theme-toggle [data-theme-choice]').forEach(b =>
        b.classList.toggle('active', b === btn))
    })
  })
  $('set-accent').addEventListener('input', (e) => {
    // A hand-picked accent = the Custom look (drops the surface tint).
    if (window.applyLook) window.applyLook(e.target.value, '0,0,0', 0, 'custom')
    else if (window.applyAccent) window.applyAccent(e.target.value)
    highlightActiveLook('custom')
  })

  const lookGrid = $('look-grid')
  if (lookGrid) lookGrid.addEventListener('click', (e) => {
    const c = e.target.closest('.look-card')
    if (c) applyLookById(c.dataset.look)
  })

  // Compact chrome — icons-only titlebar; segmented toggle, applies live (class on <html>).
  document.querySelectorAll('.compact-toggle [data-compact-choice]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.applyCompactChrome) window.applyCompactChrome(btn.dataset.compactChoice === '1')
      document.querySelectorAll('.compact-toggle [data-compact-choice]').forEach(b =>
        b.classList.toggle('active', b === btn))
    })
  })

  // Card density — applies live via CSS (data-attr on <html>); no re-render needed.
  document.querySelectorAll('[data-density-choice]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (window.applyDensity) window.applyDensity(btn.dataset.densityChoice)
      document.querySelectorAll('[data-density-choice]').forEach(b =>
        b.classList.toggle('active', b === btn))
    })
  })
})()
