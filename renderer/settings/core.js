// Settings modal: core registry, open/save/cancel pipeline, and live-prefs snapshot/revert.
// Other tabs register their populate/collect/validate hooks via CSMSettings.register().
;(function () {
  const modal = document.getElementById('settings-modal')
  if (!modal) return
  const form = document.getElementById('settings-form')
  const errEl = document.getElementById('set-error')
  const $ = (id) => document.getElementById(id)

  const escAttr = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;')

  function showError(msg) { errEl.textContent = msg; errEl.hidden = false }
  function clearError() { errEl.hidden = true; errEl.textContent = '' }

  function showSettingsTab(name) {
    modal.querySelectorAll('.settings-tab').forEach(t => t.classList.toggle('active', t.dataset.settingsTab === name))
    modal.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.settingsPanel === name))
  }
  const settingsNav = modal.querySelector('.settings-nav')
  if (settingsNav) settingsNav.addEventListener('click', (e) => {
    const tab = e.target.closest('.settings-tab')
    if (tab) showSettingsTab(tab.dataset.settingsTab)
  })

  function refreshBoardIfOpen() {
    if (window.viewMode === 'board' && window.renderBoard) window.renderBoard()
  }

  // Several controls apply LIVE (localStorage / board state) so you can preview them:
  // theme, accent, card density, terminal appearance, and the Kanban columns. They
  // must commit only on Save — Cancel/Esc reverts the whole live set to the snapshot
  // taken when the modal opened. (Config-backed fields — roots, categories, Jira,
  // knowledge notes, terminal app — are already Save-gated via collect()/setConfig, so they
  // revert on Cancel for free; no snapshot needed.)
  let liveSnapshot = null
  let settingsSaved = false
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)))
  function snapshotLivePrefs() {
    return {
      theme: window.getTheme ? window.getTheme() : 'dark',
      accent: window.getAccent ? window.getAccent() : window.CSM_COLORS.accent,
      density: window.getDensity ? window.getDensity() : 'detailed',
      compact: window.getCompactChrome ? window.getCompactChrome() : false,
      keys: window.getKeys ? window.getKeys() : null,
      terminal: window.getTerminalPrefs ? clone(window.getTerminalPrefs()) : null,
      board: window.CSMBoard ? clone(window.CSMBoard.load()) : null,
      // The active look (accent + surface tint) applies live, so capture it to revert.
      look: window.getLook ? window.getLook() : null,
    }
  }
  function restoreLivePrefs(s) {
    if (!s) return
    if (window.applyTheme) window.applyTheme(s.theme)
    if (s.look && window.applyLook) window.applyLook(s.accent, s.look.tint, s.look.tintA, s.look.id)
    else if (window.applyAccent) window.applyAccent(s.accent)
    if (window.applyDensity) window.applyDensity(s.density)
    if (window.applyCompactChrome) window.applyCompactChrome(s.compact)
    if (s.keys && window.setKeys) window.setKeys(s.keys)
    if (s.terminal && window.setTerminalPrefs) window.setTerminalPrefs(s.terminal)
    if (s.board && window.CSMBoard) { window.CSMBoard.save(s.board); refreshBoardIfOpen() }
  }

  // Registry: each tab registers populate/collect/validate hooks.
  // Open calls populate in order, Save calls collect then validate in order.
  const registry = []
  window.CSMSettings = {
    register(mod) {
      registry.push(mod)
    }
  }

  // Open settings modal: snapshot live state, populate all tabs, show general tab, open modal.
  $('settings-btn').addEventListener('click', () => {
    liveSnapshot = snapshotLivePrefs()
    settingsSaved = false
    registry.forEach(mod => {
      if (mod.populate) mod.populate(window.CSM_CONFIG || {})
    })
    clearError()
    showSettingsTab('general')   // always open on the first tab
    modal.showModal()
  })

  // Close/cancel: revert live prefs if not saved.
  modal.addEventListener('close', () => {
    if (!settingsSaved) restoreLivePrefs(liveSnapshot)
    settingsSaved = false
  })
  $('set-cancel').addEventListener('click', () => modal.close())

  // Browse → native folder picker; fill the paired input. On cancel the picker
  // resolves null → leave the existing value untouched.
  modal.addEventListener('click', async (e) => {
    const btn = e.target.closest('.path-browse[data-browse]')
    if (!btn) return
    const target = document.getElementById(btn.dataset.browse)
    if (!target || !window.api.pickDirectory) return
    const picked = await window.api.pickDirectory()
    if (picked) target.value = picked
  })

  // Save: validate, persist (Rust re-validates), and ONLY close on success —
  // on failure keep the modal open with an inline error so edits aren't lost.
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError()

    // Seed the output and context object.
    const out = { version: 2 }
    const ctx = {}

    // Collect from all tabs in order.
    registry.forEach(mod => {
      if (mod.collect) mod.collect(out, ctx)
    })

    // Validate in order — first error wins.
    for (const mod of registry) {
      if (mod.validate) {
        const err = mod.validate(out)
        if (err) { showError(err); return }
      }
    }

    const res = await window.api.setConfig(out)
    if (!res || !res.ok) {
      showError('Could not save: ' + ((res && res.error) || 'unknown error'))
      return
    }
    settingsSaved = true   // keep the live density (don't revert on the close event)
    modal.close()
    if (window.reloadConfig) await window.reloadConfig()
  })

  // Export helpers for other tabs to use.
  window.allCsmKeys = function() {
    const out = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.indexOf('csm.') === 0) out[k] = localStorage.getItem(k)
    }
    return out
  }
  window.showSettingsError = showError
  window.clearSettingsError = clearError
})()
