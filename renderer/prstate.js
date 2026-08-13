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

  // ── Tickets ──────────────────────────────────────────────────────────────────
  // A tracker's statuses are per-project ("Triaged", "In Review", "Won't Do"), so the
  // label shown is always the raw one. Only the COLOUR is folded, into the same four
  // families as a PR — one grammar for both: ● it is moving, ✔ it is finished,
  // ✕ abandoned, ◌ nothing yet.
  //
  // Matched on whole words so "Done" hits and "Doneness" does not, and longest-family
  // first so "In Review" is active rather than falling through to unknown.
  const TICKET_FAMILIES = [
    ['closed', ["won't do", 'wont do', 'cancelled', 'canceled', 'rejected', 'duplicate', 'abandoned', 'invalid']],
    ['merged', ['done', 'resolved', 'closed', 'complete', 'completed', 'shipped', 'released', 'fixed', 'merged']],
    ['open', ['in progress', 'in review', 'review', 'triaged', 'doing', 'started', 'implementing', 'testing', 'blocked']],
    ['draft', ['to do', 'todo', 'open', 'new', 'backlog', 'selected for development', 'triage', 'untriaged']],
  ]

  function ticketFamily(status) {
    const s = String(status || '').trim().toLowerCase()
    if (!s) return 'unknown'
    for (const [family, words] of TICKET_FAMILIES) {
      if (words.some((w) => s === w || s.includes(w))) return family
    }
    return 'unknown'
  }

  // `["GOSDK-1: In Review", "GOSDK-2: Done"]` → `{ "GOSDK-1": "In Review", … }`.
  // Written by the session skills as YAML `- ID: Status` entries: valid YAML, and the
  // existing list parser hands each one back whole, so no map parser was needed. An
  // entry without a colon is dropped rather than guessed at.
  function ticketStateMap(entries) {
    const out = {}
    for (const raw of entries || []) {
      const i = String(raw).indexOf(':')
      if (i <= 0) continue
      const id = String(raw).slice(0, i).trim()
      const status = String(raw).slice(i + 1).trim()
      if (id && status) out[id] = status
    }
    return out
  }

  return { GLYPH, WORD, RANK, STATES, stateOf, sessionState, ticketFamily, ticketStateMap }
})
