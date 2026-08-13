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
  // SVG paths, not Unicode characters. `✎` and `◌` are dingbats absent from SF Pro, so
  // macOS either substituted another face or drew nothing at all — draft and un-synced
  // simply had no visible mark. Every other icon in this app is an SVG for the same
  // reason. The caller wraps these in a 24×24 viewBox.
  const GLYPH = {
    open: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
    draft: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    merged: '<path d="M20 6 9 17l-5-5"/>',
    closed: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    unknown: '<circle cx="12" cy="12" r="7" stroke-dasharray="3 3"/>',
  }
  const WORD = { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed', unknown: 'not synced' }

  // Kept for callers that need to order states; the summary below does NOT use it.
  const RANK = { open: 0, draft: 1, closed: 2, merged: 3, unknown: 4 }

  const STATES = ['open', 'draft', 'merged', 'closed']

  // The state of one URL, per a { url: { state } } map. Anything we have not synced —
  // or synced into a value we don't recognise — is `unknown`, never blank: showing
  // nothing reads as "no PR here", when the truth is "we have not asked".
  function stateOf(status, url) {
    const s = (status && status[url] && status[url].state) || ''
    return STATES.includes(s) ? s : 'unknown'
  }

  // The state of a whole set — but ONLY when they agree. Picking the "most demanding" one
  // instead was actively misleading: three PRs of which one was closed showed a cross
  // reading "closed", when two were still open. Disagreement returns `mixed`, and the
  // caller shows no state at all: one icon cannot honestly summarise three answers, and
  // the picker is one click away.
  function summaryState(status, urls) {
    const list = (urls || []).map((u) => stateOf(status, u))
    if (!list.length) return 'unknown'
    return list.every((s) => s === list[0]) ? list[0] : 'mixed'
  }

  // Same rule for any list of already-resolved states (ticket families).
  function summaryOf(states) {
    const list = states || []
    if (!list.length) return 'unknown'
    return list.every((s) => s === list[0]) ? list[0] : 'mixed'
  }

  // ── Tickets ──────────────────────────────────────────────────────────────────
  // A tracker's statuses are per-project ("Triaged", "In Review", "Won't Do"), so the
  // label shown is always the raw one. Only the COLOUR is folded, into the same four
  // families as a PR — one grammar for both: ● it is moving, ✔ it is finished,
  // ✕ abandoned, ✎ still being written, ◌ nothing yet.
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

  return { GLYPH, WORD, RANK, STATES, stateOf, summaryState, summaryOf, ticketFamily, ticketStateMap }
})
