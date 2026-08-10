// "Recent · unmanaged" section — pure model + HTML builder. UMD: usable as a
// <script> in the renderer (window.CSMUnmanaged) and via require() in jest.
// No DOM, no state — app.js owns the wiring + discovery.
(function (root, factory) {
  const F = (typeof module !== 'undefined' && module.exports)
    ? require('./lib/formatters')
    : root.CSMFormatters
  const api = factory(F)
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.CSMUnmanaged = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function (F) {
  const esc = F.escapeHtml

  function basename(p) {
    if (!p) return ''
    const parts = String(p).replace(/\/+$/, '').split('/')
    return parts[parts.length - 1] || ''
  }

  // A short, human name for a session: its own first prompt, which actually says what the
  // work is. The cwd basename is only a fallback — a session started in ~/TomTom would
  // otherwise be adopted as "TomTom", which names the folder rather than the task.
  function suggestName(session) {
    const title = String(session.title || '').trim()
    if (title) {
      const firstLine = title.split('\n')[0].trim()
      const clipped = firstLine.length > 60 ? firstLine.slice(0, 60).replace(/\s+\S*$/, '') : firstLine
      if (clipped) return clipped
    }
    return basename(session.cwd || '')
  }

  function buildUnmanagedModel(sessions, now) {
    const list = Array.isArray(sessions) ? sessions : []
    if (!list.length) return { empty: true, rows: [] }
    const rows = list.map(s => ({
      sessionId: s.sessionId,
      title: s.title || '(untitled session)',
      cwd: s.cwd || '',
      when: s.mtime ? F.formatTimestamp(new Date(s.mtime * 1000).toISOString(), now) : '',
      defaultName: suggestName(s),
    }))
    return { empty: false, rows }
  }

  function rowHtml(r) {
    const tip = `${esc(r.title)}${r.cwd ? '\n' + esc(r.cwd) : ''}`
    return `<div class="unmanaged-row" title="${tip}">
      <div class="unmanaged-row-text">
        <span class="unmanaged-row-title">${esc(r.title)}</span>
        <span class="unmanaged-row-meta">${esc(r.cwd)}</span>
        ${r.when ? `<span class="unmanaged-row-when">${esc(r.when)}</span>` : ''}
      </div>
      <button type="button" class="unmanaged-adopt" data-adopt-sid="${esc(r.sessionId)}" data-adopt-name="${esc(r.defaultName)}" data-adopt-title="${esc(r.title)}">Adopt</button>
    </div>`
  }

  function bodyHtml(state) {
    if (state.loading) return `<div class="unmanaged-empty">Loading…</div>`
    if (state.error) return `<div class="unmanaged-error">${esc(state.error)} <button type="button" class="unmanaged-retry" data-unmanaged-refresh>↻ Retry</button></div>`
    const model = state.model
    if (!model || model.empty) return `<div class="unmanaged-empty">No unmanaged sessions.</div>`
    return model.rows.map(rowHtml).join('')
  }

  function unmanagedSectionHtml(state) {
    const collapsed = !state.expanded
    const body = state.expanded ? `<div class="unmanaged-body">${bodyHtml(state)}</div>` : ''
    return `<div class="unmanaged-group">
      <div class="unmanaged-header" data-unmanaged-toggle>
        <span class="category-chevron ${collapsed ? 'collapsed' : ''}">›</span>
        <span class="unmanaged-name">Recent · unmanaged</span>
        <button type="button" class="unmanaged-refresh" data-unmanaged-refresh title="Rescan" aria-label="Rescan">↻</button>
      </div>
      ${body}
    </div>`
  }

  return { basename, suggestName, buildUnmanagedModel, unmanagedSectionHtml }
})
