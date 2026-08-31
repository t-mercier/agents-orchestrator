// Shared "would this Install/update go backward?" logic for session skills. UMD:
// window.CSMSkillsUpdate in the renderer + require() in jest. Pure — no DOM, no
// window.api — so both the Settings button (renderer/settings/general.js) and the
// automatic launch banner (renderer/app.js) compare dates and word the dialog the same
// way instead of drifting apart.
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

  // The one-line banner text for the automatic "an update is available" nudge — only
  // meaningful once the caller has already confirmed compareEpochs(status).isNewer.
  function updateBannerText(status, differs) {
    const cmp = compareEpochs(status)
    return `A newer version of the session skills is available (${fmtDate(cmp.bundleEpoch)}, you have ${fmtDate(cmp.installedEpoch)}): ${differs.join(', ')}.`
  }

  return { fmtDate, compareEpochs, overwriteDialog, updateBannerText }
})
