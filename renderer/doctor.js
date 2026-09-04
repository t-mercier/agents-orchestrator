// Doctor: show what the scan found, apply only what the user ticks.
//
// The panel deliberately opens with nothing selected. Doctor writes to the session
// registry and to notes files — the same places a bad sync would — so "Repair selected"
// starts disabled and stays that way until a deliberate choice is made. Informational
// findings render without a checkbox at all: there is nothing to apply, and offering a
// control that does nothing is how a tool teaches people to click without reading.
;(function () {
  const $ = (id) => document.getElementById(id)
  const modal = $('doctor-modal')
  if (!modal) return

  let findings = []
  const picked = new Set()

  const SEVERITY = {
    broken: { label: 'Broken', hint: 'work you cannot reach from the app' },
    untidy: { label: 'Residue', hint: 'safe to leave, safe to clear' },
    info: { label: 'For information', hint: 'nothing to repair' },
  }

  function summarise() {
    const repairable = findings.filter((f) => f.repair).length
    if (!findings.length) return 'Nothing to repair — the session store is consistent.'
    if (!repairable) return `${findings.length} observation${findings.length > 1 ? 's' : ''}, none of which needs a repair.`
    return `${repairable} repairable finding${repairable > 1 ? 's' : ''}. Tick what you want fixed — nothing is written until you do.`
  }

  function render() {
    $('doctor-summary').textContent = summarise()
    const list = $('doctor-list')
    list.textContent = ''
    for (const sev of ['broken', 'untidy', 'info']) {
      const group = findings.filter((f) => f.severity === sev)
      if (!group.length) continue
      const head = document.createElement('div')
      head.className = 'doctor-group'
      head.innerHTML = `<strong></strong> <em></em>`
      head.querySelector('strong').textContent = SEVERITY[sev].label
      head.querySelector('em').textContent = `— ${SEVERITY[sev].hint}`
      list.appendChild(head)

      for (const f of group) {
        const row = document.createElement('label')
        row.className = 'doctor-row' + (f.repair ? '' : ' doctor-row-inert')
        if (f.repair) {
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.checked = picked.has(f.id)
          box.addEventListener('change', () => {
            if (box.checked) picked.add(f.id)
            else picked.delete(f.id)
            $('doctor-repair').disabled = picked.size === 0
          })
          row.appendChild(box)
        }
        const text = document.createElement('div')
        const title = document.createElement('div')
        title.className = 'doctor-title'
        title.textContent = f.title
        const detail = document.createElement('div')
        detail.className = 'doctor-detail'
        // The target is the file or pid the repair will touch. Saying so before the fact
        // is the difference between a tool you trust and one you undo afterwards.
        detail.textContent = f.repair ? `${f.detail} → ${f.repair}${f.target ? ` (${f.target})` : ''}` : f.detail
        text.append(title, detail)
        row.appendChild(text)
        list.appendChild(row)
      }
    }
    $('doctor-repair').disabled = picked.size === 0
  }

  async function scan() {
    picked.clear()
    $('doctor-summary').textContent = 'Scanning…'
    $('doctor-list').textContent = ''
    $('doctor-repair').disabled = true
    try {
      findings = (await window.api.doctorScan()) || []
    } catch (e) {
      findings = []
      $('doctor-summary').textContent = `Scan failed: ${e}`
      return
    }
    render()
  }

  window.openDoctor = async function openDoctor() {
    if (!window.api || !window.api.doctorScan) return
    if (!modal.open) modal.showModal()
    await scan()
  }

  $('doctor-close').addEventListener('click', () => modal.close())
  $('doctor-rescan').addEventListener('click', scan)

  $('doctor-repair').addEventListener('click', async () => {
    const ids = [...picked]
    $('doctor-repair').disabled = true
    const res = await window.api.doctorRepair(ids)
    const failed = (res && res.failed) || []
    const fixed = ((res && res.fixed) || []).length
    // Re-scan rather than trust the reply: a repair changes what the next check sees,
    // and a stale list is how a user comes to believe something was fixed that wasn't.
    await scan()
    const parts = [fixed ? `Repaired ${fixed}.` : 'Nothing was repaired.']
    for (const f of failed) parts.push(`${f.id.split(':')[0]}: ${f.error}`)
    $('doctor-summary').textContent = `${parts.join(' ')} ${summarise()}`
    // A repair changes what the sidebar should show — un-archiving moves a session
    // between tabs. Ask for a fetch now rather than leaving the user looking at a list
    // that disagrees with the panel until the next poll.
    if (fixed && window.refreshSessions) window.refreshSessions()
  })
})()
