// Shared session-skills sync summary. UMD: window.CSMSkillsUpdate in the renderer +
// require() in jest. Pure — no DOM, no window.api — so Settings' "Sync skills" button
// and the launch notice (renderer/app.js) report a SyncReport the same way instead of
// drifting apart. The app's skills are app-owned: syncs apply without asking, and this
// summary is the visibility that replaces the permission dialog — it must always name
// what changed and where a preserved copy went.
(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.CSMSkillsUpdate = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Summarises a SyncReport (src-tauri/src/skills.rs sync_skills()) into one string.
  // `installed` filters out `lib` (always refreshed, never itself a slash-command
  // skill worth naming).
  function syncResultText(report) {
    if (report.skipped_ahead) {
      return 'Your installed skills are already at (or past) this app version — nothing was touched.'
    }
    const installed = (report.installed || []).filter(s => s !== 'lib')
    const updated = report.updated || []
    const backedUp = report.backed_up || []
    const bits = []
    if (installed.length) {
      bits.push(`Installed ${installed.length} new skill${installed.length === 1 ? '' : 's'}: ${installed.join(', ')}.`)
    }
    if (updated.length) {
      bits.push(`Updated ${updated.length} to this app version: ${updated.join(', ')}.`)
    }
    if (backedUp.length) {
      bits.push(`Your edited cop${backedUp.length === 1 ? 'y' : 'ies'} of ${backedUp.map(b => b.name).join(', ')} ${backedUp.length === 1 ? 'was' : 'were'} kept in ~/.claude/skills/.archive/.`)
    }
    if (!bits.length) bits.push('Already up to date.')
    return bits.join(' ')
  }

  return { syncResultText }
})
