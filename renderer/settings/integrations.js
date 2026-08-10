// Settings: Integrations tab — ticket URL + knowledge-notes toggle.
// Per-space vault paths have moved to the General tab (spaces editor).
;(function () {
  const modal = document.getElementById('settings-modal')
  if (!modal) return
  const $ = (id) => document.getElementById(id)

  // Populate integrations fields from config.
  function populateIntegrations() {
    const c = window.CSM_CONFIG || {}
    // Read either name: a config saved before the rename still carries `obsidian`.
    const obs = c.knowledge || c.obsidian || {}
    $('set-obsidian-enabled').checked = !!obs.enabled
    $('set-ticket').value = c.ticketBaseUrl || ''
  }

  // Collect integrations fields into config.
  function collectIntegrations(out) {
    // Write the new name only — this is what migrates a user's file, on their next Save.
    out.knowledge = {
      enabled: $('set-obsidian-enabled').checked,
    }
    out.ticketBaseUrl = $('set-ticket').value.trim()
  }

  // Register populate and collect.
  window.CSMSettings.register({
    populate: populateIntegrations,
    collect: collectIntegrations,
  })
})()
