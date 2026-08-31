// Settings: General tab — spaces (roots), backup export/import, install skills.
;(function () {
  const modal = document.getElementById('settings-modal')
  if (!modal) return
  const spaceList = document.getElementById('set-space-list')
  const errEl = document.getElementById('set-error')
  const $ = (id) => document.getElementById(id)

  const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/
  const escAttr = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;')

  // ── Spaces editor: each row = {name, path, vaultPath}. Renaming a space (the name changed from
  // its original) retags the categories under it on save; the path re-points scanning.
  // vaultPath is the knowledge-notes folder for this space (optional). Plain Markdown —
  // Obsidian is one way to browse it, not a requirement.
  let spaceRowSeq = 0
  function addSpaceRow(space = {}) {
    const idPath = `set-space-path-${spaceRowSeq}`
    const idVault = `set-space-vault-${spaceRowSeq++}`
    const item = document.createElement('div')
    item.className = 'settings-space-item'
    item.dataset.orig = space.name || ''   // original name → detect rename for category retag
    // Line 1: name + Browse + remove. Line 2: the selected path. Line 3: the vault path (optional).
    item.innerHTML = `
      <div class="settings-space-row">
        <input class="space-name" type="text" placeholder="Name" value="${escAttr(space.name)}" spellcheck="false" autocomplete="off">
        <button type="button" class="modal-btn path-browse" data-browse="${idPath}">Browse…</button>
        <button type="button" class="icon-btn space-remove" title="Remove this space (its folders on disk are left untouched)">✕</button>
      </div>
      <input class="space-path" id="${idPath}" type="text" placeholder="No folder selected — click Browse" value="${escAttr(space.path)}" readonly spellcheck="false" autocomplete="off" title="${escAttr(space.path)}">
      <div style="font-size:0.85em;color:var(--text-2);margin-top:0.25em;">Knowledge notes (optional) — any folder of Markdown:</div>
      <input class="space-vault" id="${idVault}" type="text" placeholder="Folder of Markdown notes for this space (Obsidian vault, or any folder)" value="${escAttr(space.vaultPath || '')}" spellcheck="false" autocomplete="off">`
    item.querySelector('.space-remove').addEventListener('click', () => item.remove())
    spaceList.appendChild(item)
  }
  function renderSpaceRows() {
    if (!spaceList) return
    spaceList.innerHTML = ''
    const roots = (window.CSM_CONFIG && Array.isArray(window.CSM_CONFIG.roots)) ? window.CSM_CONFIG.roots : []
    if (!roots.length) addSpaceRow()
    else roots.forEach(addSpaceRow)
  }

  // Collect spaces and build the rename map for categories (ctx.renameMap).
  function collectSpaces(out, ctx) {
    // Spaces (roots) from the editor. A row whose name changed from its original is a
    // rename → remember old→new so the categories under it follow.
    const rename = {}
    const roots = []
    if (spaceList) {
      for (const item of spaceList.querySelectorAll('.settings-space-item')) {
        const name = item.querySelector('.space-name').value.trim()
        const path = item.querySelector('.space-path').value.trim()
        const vaultPath = item.querySelector('.space-vault').value.trim()
        if (!name) continue
        if (item.dataset.orig && item.dataset.orig !== name) rename[item.dataset.orig] = name
        const root = { name, path }
        if (vaultPath) root.vaultPath = vaultPath
        roots.push(root)
      }
    }

    out.roots = roots

    // Pass the rename map to categories.js via ctx.
    ctx.renameMap = rename
  }

  function validateSpaces(cfg) {
    const roots = cfg.roots || []
    if (!roots.length) return 'Add at least one space.'
    const spaceNames = new Set()
    for (const r of roots) {
      if (!r.name || r.name.length > 30) return `Invalid space name "${r.name || '(empty)'}".`
      if (!r.path) return `Space "${r.name}" needs a path.`
      if (spaceNames.has(r.name)) return `Duplicate space "${r.name}".`
      spaceNames.add(r.name)
    }
    return null
  }

  // Register this tab's hooks.
  window.CSMSettings.register({
    populate: renderSpaceRows,
    collect: collectSpaces,
    validate: validateSpaces,
  })

  // ── Backup: export / import all UI settings (manual, file the user keeps) ──
  if ($('set-add-space')) $('set-add-space').addEventListener('click', () => addSpaceRow())

  if ($('set-export')) $('set-export').addEventListener('click', async () => {
    if (!window.api || !window.api.exportSettings) return
    const res = await window.api.exportSettings(JSON.stringify(window.allCsmKeys(), null, 2))
    if (res && res.ok === false && window.confirmAction) {
      window.confirmAction({ title: 'Export failed', body: res.error || 'unknown error', confirmLabel: 'OK' })
    } else if (res && res.saved && window.confirmAction) {
      window.confirmAction({ title: 'Settings exported', body: 'Your settings were saved. Import this file after a reinstall.', confirmLabel: 'OK' })
    }
  })
  if ($('set-import')) $('set-import').addEventListener('click', async () => {
    if (!window.api || !window.api.importSettings) return
    const res = await window.api.importSettings()
    if (!res || !res.ok) { if (res && window.confirmAction) window.confirmAction({ title: 'Import failed', body: res.error || 'unknown error', confirmLabel: 'OK' }); return }
    if (!res.content) return   // cancelled
    let parsed
    try { parsed = JSON.parse(res.content) } catch { return }
    if (!parsed || typeof parsed !== 'object') return
    const go = window.confirmAction
      ? await window.confirmAction({ title: 'Import settings', body: 'Replace your current settings (board, looks, shortcuts…) with the imported ones? The window reloads.', confirmLabel: 'Import' }).then(c => c === 'confirm')
      : true
    if (!go) return
    Object.keys(parsed).forEach(k => { if (k.indexOf('csm.') === 0 && typeof parsed[k] === 'string') localStorage.setItem(k, parsed[k]) })
    window.location.reload()
  })

  // ── Session skills: install missing ones + adopt bundle changes that don't clobber a
  // local /skill-propose patch. Safe by construction — a skill only YOU changed since
  // the last sync point is never touched, so no confirm gate before acting, only a
  // results summary after (same as the first-launch banner's non-force install).
  if ($('set-install-skills')) $('set-install-skills').addEventListener('click', async () => {
    if (!window.api || !window.api.updateSkills) return
    const res = await window.api.updateSkills()
    if (!res || !res.ok) {
      if (window.confirmAction) window.confirmAction({ title: 'Skills update failed', body: (res && res.error) || 'unknown error', confirmLabel: 'OK' })
      return
    }
    const bits = [window.CSMSkillsUpdate ? window.CSMSkillsUpdate.updateResultText(res) : 'Done.']
    if (res.config_seeded) bits.push('Seeded a default config.')
    if ((res.dirs_created || []).length) bits.push(`Created ${res.dirs_created.length} category folder${res.dirs_created.length === 1 ? '' : 's'}.`)
    bits.push('Open a fresh Claude Code session to pick up any changes.')
    if (window.confirmAction) window.confirmAction({ title: 'Session skills updated', body: bits.join(' '), confirmLabel: 'OK' })
  })

  // ── Explicit escape hatch: force every bundled skill back to exactly what THIS app
  // version ships, including ones with your own local changes. The update above never
  // does this on its own — this is the only path that can, and it always warns by name
  // first (the same dialog the launch banner's own escape hatch would use, worded by
  // window.CSMSkillsUpdate against the bundle's build date vs the last full match).
  if ($('set-reset-skills')) $('set-reset-skills').addEventListener('click', async () => {
    if (!window.api || !window.api.installSkills) return
    const status = window.api.skillsStatus ? await window.api.skillsStatus() : null
    const present = (status && status.present) || []
    const differs = (status && status.differs) || []
    if (!present.length) return
    if (window.confirmAction) {
      const dialog = window.CSMSkillsUpdate
        ? window.CSMSkillsUpdate.overwriteDialog(status, present, differs)
        : {
            title: 'Overwrite session skills?',
            body: `This replaces these skills in ~/.claude/skills with the app's bundled versions: ${present.join(', ')}.${differs.length ? ` ${differs.length} of them differ from the bundled version and your changes would be lost: ${differs.join(', ')}.` : ''} Your other skills are not touched.`,
          }
      const ok = await window.confirmAction({
        ...dialog,
        confirmLabel: `Overwrite ${present.length}`,
      }).then(c => c === 'confirm')
      if (!ok) return
    }
    const res = await window.api.installSkills(true)
    if (!res || !res.ok) {
      if (window.confirmAction) window.confirmAction({ title: 'Reset failed', body: (res && res.error) || 'unknown error', confirmLabel: 'OK' })
      return
    }
    const n = (res.installed || []).filter(s => s !== 'lib').length
    if (window.confirmAction) window.confirmAction({ title: 'Session skills reset', body: `Reset ${n} skill${n === 1 ? '' : 's'} to the bundled version. Open a fresh Claude Code session to pick them up.`, confirmLabel: 'OK' })
  })
})()
