// Settings: Categories tab — category rows, seed/scheme, folder picker.
;(function () {
  const modal = document.getElementById('settings-modal')
  if (!modal) return
  const catList = document.getElementById('set-cat-list')
  const errEl = document.getElementById('set-error')
  const $ = (id) => document.getElementById(id)

  const NAME_RE = /^[A-Za-z0-9_-]{1,20}$/
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/
  const escAttr = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;')

  // Name is READ-ONLY label: it mirrors a real folder on disk (<root>/<NAME>),
  // so editing it here would drift from reality (the app never moves folders).
  // Renaming goes through the /rename-category skill, which moves the folder +
  // retags everything. Only the colour (a pure display preference) is editable.
  function addCatRow(cat = {}) {
    const name = cat.name || ''
    const root = cat.root || ''
    const row = document.createElement('div')
    row.className = 'settings-cat-row'
    row.dataset.name = name
    row.dataset.root = root
    row.innerHTML = `
      <input class="cat-color" type="color">
      <span class="cat-name-label"></span>
      <span class="cat-root-label"></span>
      <button type="button" class="icon-btn cat-remove" title="Remove from the dashboard (the folder on disk is left untouched)">✕</button>`
    row.querySelector('.cat-color').value = COLOR_RE.test(cat.color || '') ? cat.color : window.CSM_COLORS.newCategory
    row.querySelector('.cat-name-label').textContent = name || '(unnamed)'
    row.querySelector('.cat-root-label').textContent = root || '(no root)'
    row.querySelector('.cat-remove').addEventListener('click', () => row.remove())
    catList.appendChild(row)
  }

  // Populate category list from config.
  function populateCategories() {
    catList.innerHTML = ''
    const c = window.CSM_CONFIG || {}
    const cats = Array.isArray(c.categories) ? c.categories : []
    if (cats.length === 0) addCatRow()
    else cats.forEach(addCatRow)
    renderCatSeed()
  }

  // Collect categories and apply rename map from general.js.
  function collectCategories(out, ctx) {
    // Categories are folder-mirrored: only colour is editable here. PRESERVE every
    // other field from the loaded config — crucially the v2 `root`.
    // Identity is (root, name) — the same name can live under two roots —
    // so preserve per pair, not per name. A renamed space retags the category's root.
    const prevCats = (window.CSM_CONFIG && Array.isArray(window.CSM_CONFIG.categories))
      ? window.CSM_CONFIG.categories : []
    const rootOf = (c) => c.root || ''
    const byKey = new Map(prevCats.map(c => [`${rootOf(c)}\0${c.name}`, c]))
    const rename = ctx.renameMap || {}
    const categories = [...catList.querySelectorAll('.settings-cat-row')].map(row => {
      const oldRoot = row.dataset.root || ''
      const prev = byKey.get(`${oldRoot}\0${row.dataset.name}`) || {}
      return {
        name: row.dataset.name,
        color: row.querySelector('.cat-color').value,
        root: rename[oldRoot] || oldRoot,              // follow a space rename
      }
    })
    out.categories = categories
  }

  function validateCategories(cfg) {
    if (cfg.categories.length === 0) return 'Add at least one category.'
    const seen = new Set()
    const spaceNames = new Set((cfg.roots || []).map(r => r.name))
    for (const cat of cfg.categories) {
      if (!NAME_RE.test(cat.name)) {
        return `Invalid category "${cat.name || '(empty)'}" — up to 20 letters, digits, _ or -.`
      }
      // A category's space must still exist (e.g. you removed it without moving the cat).
      if (cat.root && !spaceNames.has(cat.root)) {
        return `Category "${cat.name}" is in space "${cat.root}" which isn't in your spaces — re-add that space (or remove the category) first.`
      }
      // Dedup on (root, name): the same name under two spaces is legitimate — only the
      // SAME pair twice is a real dup.
      const dkey = `${cat.root || ''}\0${cat.name}`
      if (seen.has(dkey)) return `Duplicate category "${cat.name}" under the same space.`
      seen.add(dkey)
      if (!COLOR_RE.test(cat.color)) return `Invalid color for "${cat.name}".`
    }
    return null
  }

  // Register populate, collect, and validate.
  window.CSMSettings.register({
    populate: populateCategories,
    collect: collectCategories,
    validate: validateCategories,
  })

  // ── Category colours: the SAME seed + scheme system as the board. Picking a seed
  // fills every category's colour input (generated via CSMBoard.paletteColor); the hex
  // persists in config on save. Seed/scheme remembered in localStorage. "None" = manual.
  const getCatSeed = () => { try { return localStorage.getItem('csm.catSeed') || '' } catch { return '' } }
  const getCatScheme = () => { try { return localStorage.getItem('csm.catScheme') || 'spectrum' } catch { return 'spectrum' } }
  function renderCatSeed() {
    const grid = $('set-cat-seed')
    if (!grid || !window.CSM_LOOKS || !window.CSM_LOOK_CARDS || !window.CSMBoard) return
    const seed = getCatSeed().toLowerCase()
    const matchesLook = window.CSM_LOOKS.some(L => L.accent.toLowerCase() === seed)
    grid.innerHTML = window.CSM_LOOK_CARDS({
      attr: 'cat-seed', valueOf: (L) => L.accent, none: true, customInputClass: 'cat-seed-custom-input',
    })
    const cv = (seed && !matchesLook) ? getCatSeed() : window.CSM_COLORS.accent
    const customInput = grid.querySelector('.cat-seed-custom-input')
    if (customInput) customInput.value = cv
    grid.querySelectorAll('.look-card').forEach(b => {
      const v = b.dataset.catSeed
      const active = v === '' ? !seed : v === 'custom' ? (!!seed && !matchesLook) : v.toLowerCase() === seed
      b.classList.toggle('active', active)
    })
    const scheme = getCatScheme()
    document.querySelectorAll('.cat-scheme-toggle [data-cat-scheme]').forEach(b => b.classList.toggle('active', b.dataset.catScheme === scheme))
  }
  // Fill each category row's colour input from the seed+scheme (in row order). "None"
  // seed → leave the existing manual colours untouched.
  function regenerateCatColors() {
    const seed = getCatSeed()
    if (!seed) return
    const scheme = getCatScheme()
    const inputs = [...catList.querySelectorAll('.settings-cat-row .cat-color')]
    inputs.forEach((input, i) => {
      const hex = window.CSMBoard.paletteColor(seed, scheme, i, inputs.length)
      if (hex) input.value = hex
    })
  }
  function applyCatSeed(seed) {
    try { localStorage.setItem('csm.catSeed', seed || '') } catch { /* ignore */ }
    renderCatSeed(); regenerateCatColors()
  }
  {
    const grid = $('set-cat-seed')
    if (grid) {
      grid.addEventListener('click', (e) => {
        const b = e.target.closest('.look-card[data-cat-seed]')
        if (b && b.dataset.catSeed !== 'custom') applyCatSeed(b.dataset.catSeed)
      })
      grid.addEventListener('input', (e) => {
        if (e.target.classList.contains('cat-seed-custom-input')) applyCatSeed(e.target.value)
      })
    }
    document.querySelectorAll('.cat-scheme-toggle [data-cat-scheme]').forEach(btn => btn.addEventListener('click', () => {
      try { localStorage.setItem('csm.catScheme', btn.dataset.catScheme) } catch { /* ignore */ }
      renderCatSeed(); regenerateCatColors()
    }))
  }

  // Categories are added by picking EXISTING folder(s) — the app never creates or
  // renames folders (that stays in your hands / the /rename-category skill). Each
  // chosen folder must sit directly under a space (a category maps to <space>/<NAME>).
  // Multi-select adds several at once; anything outside a space, invalid, or already
  // present is skipped with a summary.
  $('set-add-cat-folder').addEventListener('click', async () => {
    if (!window.api.pickDirectories) return
    const picked = await window.api.pickDirectories()
    if (!picked || !picked.length) return
    window.clearSettingsError()
    const c = window.CSM_CONFIG || {}
    // The named root a picked folder's PARENT dir maps to: a v2 roots entry whose path matches.
    const rootForParent = (parent) => {
      const roots = Array.isArray(c.roots) ? c.roots : []
      const hit = roots.find(r => r.path === parent)
      return hit ? hit.name : null
    }
    // Identity is (root, name) — so the SAME category name can be added under a second
    // root (e.g. AI-SYSTEM under both Work and Perso). Dedup on the pair, not the name.
    const key = (root, name) => `${root}\0${(name || '').toLowerCase()}`
    const have = new Set([...catList.querySelectorAll('.settings-cat-row')]
      .map(r => key(r.dataset.root, r.dataset.name)))
    let added = 0
    const skipped = []
    for (const path of picked) {
      const parts = path.replace(/\/+$/, '').split('/')
      const base = parts.pop() || ''
      const parent = parts.join('/')
      const root = rootForParent(parent)
      if (!root) { skipped.push(`${base} (not under a space)`); continue }
      if (!NAME_RE.test(base)) { skipped.push(`${base} (invalid name)`); continue }
      if (have.has(key(root, base))) { skipped.push(`${base} (already in ${root})`); continue }
      have.add(key(root, base))
      addCatRow({ name: base, root, color: window.CSM_COLORS.newCategory })
      added += 1
    }
    if (skipped.length) {
      const roots = (Array.isArray(c.roots) ? c.roots.map(r => r.path) : []).filter(Boolean)
      window.showSettingsError(`Added ${added}. Skipped: ${skipped.join(', ')}. Pick folders directly inside one of your spaces: ${roots.join(', ') || '—'}.`)
    }
  })
})()
