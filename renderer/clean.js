// Clean: audit the session store by age, then apply the archives and deletions the user
// ticks. The decision logic lives in lib/clean-model.js (pure, tested); this file is the
// panel around it.
//
// Nothing is pre-ticked. Archiving is reversible from the Archived tab, deleting moves a
// folder to the Trash — neither is something to hand someone as a single "clean it all"
// button, because the one time the audit is wrong is the time that button is expensive.
;(function () {
  const $ = (id) => document.getElementById(id)
  const modal = $('clean-modal')
  if (!modal) return

  const M = () => window.CSMCleanModel
  const picked = new Set()
  let result = { toArchive: [], toDelete: [], undated: 0 }
  let rowsByPath = new Map()

  const days = (id, fallback) => Number(($(id) && $(id).value) || fallback)

  function label(row) {
    const s = row.session
    const name = (window.displayName && window.displayName(s)) || s.name || s.notesPath
    return `${name} — ${row.ageDays} days`
  }

  function group(title, hint, rows, kind) {
    const wrap = document.createElement('div')
    const head = document.createElement('div')
    head.className = 'doctor-group'
    head.innerHTML = '<strong></strong> <em></em>'
    head.querySelector('strong').textContent = `${title} (${rows.length})`
    head.querySelector('em').textContent = `— ${hint}`
    wrap.appendChild(head)

    for (const row of rows) {
      const path = row.session.notesPath
      const el = document.createElement('label')
      el.className = 'doctor-row'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = picked.has(path)
      box.addEventListener('change', () => {
        if (box.checked) picked.add(path)
        else picked.delete(path)
        rowsByPath.set(path, kind)
        updateApply()
      })
      const text = document.createElement('div')
      const t = document.createElement('div')
      t.className = 'doctor-title'
      t.textContent = label(row)
      const d = document.createElement('div')
      d.className = 'doctor-detail'
      d.textContent = row.session.notesPath
      text.append(t, d)
      el.append(box, text)
      wrap.appendChild(el)
      rowsByPath.set(path, kind)
    }
    return wrap
  }

  function updateApply() {
    const btn = $('clean-apply')
    const del = [...picked].filter((p) => rowsByPath.get(p) === 'delete').length
    const arc = picked.size - del
    btn.disabled = picked.size === 0
    btn.textContent = picked.size === 0
      ? 'Apply selected'
      : `Archive ${arc}, delete ${del}`
  }

  function render() {
    const list = $('clean-list')
    list.textContent = ''
    rowsByPath = new Map()
    const total = result.toArchive.length + result.toDelete.length
    const bits = []
    if (!total) bits.push('Nothing is old enough to propose.')
    else bits.push(`${total} session${total > 1 ? 's' : ''} past the thresholds. Tick what you want acted on.`)
    // An undated session is one Clean cannot date at all — saying so beats letting the
    // user think the audit covered everything.
    if (result.undated) bits.push(`${result.undated} could not be dated and were left out.`)
    $('clean-summary').textContent = bits.join(' ')

    if (result.toArchive.length) {
      list.appendChild(group('Archive', 'moves them out of Closed; reversible from the Archived tab', result.toArchive, 'archive'))
    }
    if (result.toDelete.length) {
      list.appendChild(group('Delete', 'already archived; the folder goes to the Trash, recoverable from the Finder', result.toDelete, 'delete'))
    }
    updateApply()
  }

  async function audit() {
    picked.clear()
    $('clean-summary').textContent = 'Auditing…'
    $('clean-list').textContent = ''
    $('clean-apply').disabled = true
    let hist
    try {
      hist = await window.api.getHistoricalAll()
    } catch (e) {
      $('clean-summary').textContent = `Audit failed: ${e}`
      return
    }
    const all = [...(hist.stale || []), ...(hist.closed || []), ...(hist.archived || [])]
    result = M().audit(all, {
      now: Date.now(),
      archiveAfterDays: days('clean-archive-after', 30),
      deleteAfterDays: days('clean-delete-after', 90),
    })
    render()
  }

  window.openClean = async function openClean() {
    if (!window.api || !window.api.getHistoricalAll || !M()) return
    if (!modal.open) modal.showModal()
    await audit()
  }

  $('clean-close').addEventListener('click', () => modal.close())
  $('clean-archive-after').addEventListener('change', audit)
  $('clean-delete-after').addEventListener('change', audit)

  $('clean-apply').addEventListener('click', async () => {
    const targets = [...picked]
    const deletes = targets.filter((p) => rowsByPath.get(p) === 'delete')
    const archives = targets.filter((p) => rowsByPath.get(p) !== 'delete')
    if (window.confirmAction) {
      const choice = await window.confirmAction({
        title: 'Apply this clean-up?',
        body: `${archives.length} session(s) will be archived. ${deletes.length} folder(s) will be moved to the Trash — recoverable from the Finder.`,
        confirmLabel: 'Apply',
      })
      // `confirmAction` resolves 'cancel' on both the button and Esc — a truthy value,
      // so this has to compare, not test. Getting it wrong here deletes on Cancel.
      if (choice !== 'confirm') return
    }
    $('clean-apply').disabled = true
    let done = 0
    const failed = []
    // Archive first: a session that gets archived here is not eligible for deletion in
    // the same pass (its age has not changed, but the user only ticked one action for
    // it), so the order costs nothing and keeps the two lists independent.
    for (const p of archives) {
      try { await window.api.archiveSession(p); done++ } catch (e) { failed.push(`${p}: ${e}`) }
    }
    for (const p of deletes) {
      try { await window.api.deleteSession(p); done++ } catch (e) { failed.push(`${p}: ${e}`) }
    }
    await audit()
    const parts = [`Applied ${done} of ${targets.length}.`]
    if (failed.length) parts.push(`${failed.length} failed — ${failed[0]}`)
    $('clean-summary').textContent = `${parts.join(' ')} ${$('clean-summary').textContent}`
    if (done && window.refreshSessions) window.refreshSessions()
  })
})()
