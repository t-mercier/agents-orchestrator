// Clean: decide which sessions are old enough to propose archiving or deleting.
// UMD, pure — no DOM, no state, no clock of its own (`now` is injected).
//
// Age comes from `CSMFormatters.sessionTime`, the same fold the list's age pill uses:
// the MORE RECENT of the notes.md mtime and the transcript's last message. Clean must
// not invent a second definition of "last touched" — an audit that disagrees with the
// date on screen is an audit nobody can check.
(function (root, factory) {
  const api = factory(
    typeof module !== 'undefined' && module.exports
      ? require('./formatters')
      : root.CSMFormatters
  )
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.CSMCleanModel = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function (F) {
  const DAY = 86400000

  /// Whole days since a session was last touched, or null when nothing dates it.
  ///
  /// Null is not zero. A session with no usable date is one Clean knows nothing about,
  /// and proposing to delete it on the strength of a missing field is exactly the kind
  /// of confident wrong answer this panel must not give — it is left out instead.
  function ageInDays(session, now) {
    const t = F.sessionTime(session)
    if (!t) return null
    return Math.floor((now - t) / DAY)
  }

  /// Split sessions into what Clean proposes to archive, to delete, and what it leaves.
  ///
  /// Only archived sessions are ever proposed for deletion — the backend refuses anything
  /// else, and offering an action that will be rejected is worse than not offering it.
  /// Everything still open (`stale`) or wrapped up (`closed`) can only be archived, which
  /// is reversible from the Archived tab.
  function audit(sessions, opts) {
    const now = (opts && opts.now) || Date.now()
    const archiveAfter = (opts && opts.archiveAfterDays) || 30
    const deleteAfter = (opts && opts.deleteAfterDays) || 90
    const toArchive = []
    const toDelete = []
    let undated = 0

    for (const s of sessions || []) {
      const age = ageInDays(s, now)
      if (age === null) { undated++; continue }
      const row = { session: s, ageDays: age }
      if (s.state === 'archived') {
        if (age >= deleteAfter) toDelete.push(row)
      } else if (age >= archiveAfter) {
        toArchive.push(row)
      }
    }
    // Oldest first: the clearest candidates are the ones the user should see without
    // scrolling, and the ordering doubles as the argument for the proposal.
    const byAge = (a, b) => b.ageDays - a.ageDays
    toArchive.sort(byAge)
    toDelete.sort(byAge)
    return { toArchive, toDelete, undated }
  }

  return { ageInDays, audit, DAY }
})
