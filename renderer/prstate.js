// Pull-request state vocabulary — pure lookup + ranking, no DOM and no state.
// UMD: a <script> in the renderer (window.CSMPrState) and require() in jest.
//
// The glyph is not decoration. Colour alone would fail a colour-blind reader, and this
// app already spends green / orange / red on the SESSION status dot, a few pixels away
// on the same card. The glyph is what separates the two vocabularies.
(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.CSMPrState = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const GLYPH = { open: '●', draft: '◍', merged: '✔', closed: '✕', unknown: '◌' }
  const WORD = { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed', unknown: 'not synced' }

  // Lower ranks win. Open outranks merged because open is the one that still needs you;
  // unknown ranks last so a single un-synced PR never masks a state we do know.
  const RANK = { open: 0, draft: 1, closed: 2, merged: 3, unknown: 4 }

  const STATES = ['open', 'draft', 'merged', 'closed']

  // The state of one URL, per a { url: { state } } map. Anything we have not synced —
  // or synced into a value we don't recognise — is `unknown`, never blank: showing
  // nothing reads as "no PR here", when the truth is "we have not asked".
  function stateOf(status, url) {
    const s = (status && status[url] && status[url].state) || ''
    return STATES.includes(s) ? s : 'unknown'
  }

  // The one state that represents a whole session: its most demanding PR.
  function sessionState(status, urls) {
    const list = (urls || []).map((u) => stateOf(status, u))
    if (!list.length) return 'unknown'
    return list.reduce((a, b) => (RANK[b] < RANK[a] ? b : a))
  }

  return { GLYPH, WORD, RANK, STATES, stateOf, sessionState }
})
