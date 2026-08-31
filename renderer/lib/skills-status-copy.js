// Shared session-skills-update copy for the renderer. UMD: window.CSMSkillsUpdate +
// require() in jest. Pure — no DOM, no window.api. Two independent concerns share this
// file because both are about the same button: `updateResultText` summarises what the
// safe, base-aware update (src-tauri/src/skills.rs update_skills()) actually did;
// `compareEpochs`/`overwriteDialog` word the EXPLICIT "reset to bundled version" escape
// hatch, which can discard local changes and so still warns by date before acting.
(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.CSMSkillsUpdate = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function fmtDate(epochSeconds) {
    return new Date(epochSeconds * 1000).toLocaleDateString()
  }

  // `status`: the object returned by window.api.skillsStatus() — { bundle_epoch,
  // installed_epoch, ... }. `known` is false whenever either date is absent (an app
  // built before this feature, or a tree never stamped by either installer) — the
  // only case where "newer" or "older" would be a guess rather than a fact.
  function compareEpochs(status) {
    const bundleEpoch = typeof (status && status.bundle_epoch) === 'number' ? status.bundle_epoch : 0
    const installedEpoch = typeof (status && status.installed_epoch) === 'number' ? status.installed_epoch : null
    const known = bundleEpoch > 0 && installedEpoch !== null
    return {
      known,
      isNewer: known && bundleEpoch > installedEpoch,
      isOlderOrSame: known && bundleEpoch <= installedEpoch,
      bundleEpoch,
      installedEpoch,
    }
  }

  // The confirm-dialog {title, body} for the manual "Overwrite N" flow — also the
  // dialog the automatic banner's CTA opens; the banner never applies without it, since
  // a date comparison alone can't tell "upstream moved on" from "you customised this
  // after the last stamp" — only the named diff list in `differs` can raise that flag.
  function overwriteDialog(status, present, differs) {
    const cmp = compareEpochs(status)
    const diffNote = differs.length
      ? ` ${differs.length} of them differ from the bundled version and your changes would be lost: ${differs.join(', ')}.`
      : ''
    let title = 'Overwrite session skills?'
    let lead = `This replaces these skills in ~/.claude/skills with the app's bundled versions: ${present.join(', ')}.`
    if (cmp.isOlderOrSame) {
      title = 'This would go backward'
      lead = `What's on disk already matches skills as of ${fmtDate(cmp.installedEpoch)} — this app's bundle is from ${fmtDate(cmp.bundleEpoch)}, no later. Overwriting replaces these with the OLDER bundled versions: ${present.join(', ')}.`
    } else if (cmp.isNewer) {
      lead = `This app's bundle (${fmtDate(cmp.bundleEpoch)}) is newer than what's on disk (${fmtDate(cmp.installedEpoch)}). Updates these to the bundled versions: ${present.join(', ')}.`
    }
    return { title, body: `${lead}${diffNote} Your other skills are not touched.` }
  }

  // Summarises an UpdateReport (src-tauri/src/skills.rs update_skills()) into one
  // string for the result dialog — shared by Settings' "Install / update" button and
  // the launch banner's own CTA, so both report the same way. `installed` filters out
  // `lib` (always refreshed, never itself a slash-command skill worth naming).
  function updateResultText(report) {
    const installed = (report.installed || []).filter(s => s !== 'lib')
    const updated = report.updated || []
    const keptLocal = report.kept_local || []
    const conflicts = report.conflicts || []
    const bits = []
    if (installed.length) {
      bits.push(`Installed ${installed.length} new skill${installed.length === 1 ? '' : 's'}: ${installed.join(', ')}.`)
    }
    if (updated.length) {
      bits.push(`Updated ${updated.length} from upstream: ${updated.join(', ')}.`)
    }
    if (keptLocal.length) {
      bits.push(`Kept your own changes to ${keptLocal.length}, not touched: ${keptLocal.join(', ')}.`)
    }
    if (conflicts.length) {
      bits.push(`${conflicts.length} have both your changes and an upstream update, so nothing was applied automatically: ${conflicts.join(', ')}.`)
    }
    if (!bits.length) bits.push('Already up to date.')
    return bits.join(' ')
  }

  return { fmtDate, compareEpochs, overwriteDialog, updateResultText }
})
