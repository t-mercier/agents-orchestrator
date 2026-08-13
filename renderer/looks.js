// Curated "looks" (Settings → Appearance). A look = a brand `accent` + a faint
// surface `tint` (rgb triplet) washed over the window background at `tintA` opacity —
// a subtle warm/cool ambiance, not a recolour of the whole UI. Category chips keep
// their own configured colours. A "Custom" card (added by the UI) drops the tint and
// opens the accent picker.
//
// Palette: soft, poetic, Pantone-leaning tones (powdery pastels, muted jewels). The
// accents are light pastels — perfectly legible on the near-black dark UI, and the
// CTA text auto-flips to dark on them (luminance, --on-accent). Inspired by the
// restrained-colour school (Things 3 · Arc · Bear): an atmosphere, not a rainbow.
window.CSM_LOOKS = [
  { id: 'ardoise',     name: 'Ardoise',     accent: '#7E93B8', tint: '0,0,0',       tintA: 0 },     // slate — neutral default
  { id: 'lavande',     name: 'Lavande',     accent: '#A88FD0', tint: '178,155,212', tintA: 0.05 },  // lavender
  { id: 'rose-poudre', name: 'Rose Poudré', accent: '#D9A2AE', tint: '222,172,182', tintA: 0.05 },  // powder rose
  { id: 'brume',       name: 'Brume',       accent: '#88AEC4', tint: '150,180,200', tintA: 0.045 }, // misty blue-grey
  { id: 'sauge',       name: 'Sauge',       accent: '#9DB389', tint: '165,185,150', tintA: 0.045 }, // sage
  { id: 'peche',       name: 'Pêche',       accent: '#F0A988', tint: '245,200,175', tintA: 0.05 },  // Peach Fuzz (Pantone 2024)
  { id: 'celadon',     name: 'Céladon',     accent: '#8FC9B9', tint: '150,205,185', tintA: 0.045 }, // celadon seafoam
]

// Shared color constants — the single source for hexes that were duplicated across
// app.js / settings.js. Frozen. (style.css's `--accent` mirrors `accent` by hand —
// CSS can't read JS; its comment cross-references here.)
window.CSM_COLORS = Object.freeze({
  accent:      window.CSM_LOOKS[0].accent,  // '#7E93B8' — Ardoise, the default look
  newCategory: '#8fd9ff',                   // colour given to a freshly added category
  neutral:     '#8a8f98',                   // grey fallback for unknown/invalid colours
})

// The look-card grid, rendered once for the three places that offer the same choice:
// Appearance (the look itself), Category colours and Board column colours. It used to be
// copy-pasted per module, and the copies drifted — the board drew flat colour blocks
// while the other two drew a tinted card with the accent as an inner dot, which is why
// that one panel looked like it belonged to a different app.
//
// `attr` is the data- attribute each caller keys its click handler on ('look',
// 'cat-seed', 'board-seed'); `valueOf` turns a look into that attribute's value.
window.CSM_LOOK_CARDS = function lookCards({ attr, valueOf, none = false, custom = true, customInputClass = '' }) {
  const card = (val, name, swatch) =>
    `<button type="button" class="look-card" data-${attr}="${val}" title="${name}">${swatch}<span class="look-name">${name}</span></button>`
  // The tint reads stronger in a small card than as the live wash, or it vanishes.
  const cards = window.CSM_LOOKS.map((L) => {
    const bg = L.tintA ? `rgba(${L.tint}, ${Math.min(0.16, L.tintA * 2.6)})` : 'rgba(var(--tint), 0.05)'
    return card(valueOf(L), L.name, `<span class="look-swatch" style="background:${bg}"><i style="background:${L.accent}"></i></span>`)
  }).join('')
  const noneCard = none
    ? card('', 'None', '<span class="look-swatch" style="background:rgba(var(--tint),0.05)"><i style="background:rgba(var(--tint),0.18)"></i></span>')
    : ''
  // Custom wraps a real colour input in a <label>, so the native picker opens AT the card.
  const customCard = !custom ? '' : customInputClass
    ? `<label class="look-card look-custom" data-${attr}="custom" title="Custom seed">
        <span class="look-swatch look-swatch-custom"><i></i></span><span class="look-name">Custom</span>
        <input type="color" class="${customInputClass}" value="${window.CSM_COLORS.accent}">
      </label>`
    : `<button type="button" class="look-card look-custom" data-${attr}="custom" title="Custom — pick your own accent">
        <span class="look-swatch look-swatch-custom"><i></i></span><span class="look-name">Custom</span>
      </button>`
  return noneCard + cards + customCard
}
