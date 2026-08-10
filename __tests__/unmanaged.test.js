const U = require('../renderer/unmanaged')

const NOW = new Date('2026-07-22T12:00:00Z').getTime()

describe('basename', () => {
  it('returns the last path segment', () => expect(U.basename('/Users/x/my-repo')).toBe('my-repo'))
  it('tolerates a trailing slash', () => expect(U.basename('/Users/x/my-repo/')).toBe('my-repo'))
  it('handles empty', () => expect(U.basename('')).toBe(''))
})

describe('suggestName', () => {
  it('names the session after its first prompt, not its folder', () => {
    // Regression: a session started in ~/TomTom was adopted as "TomTom" — the folder,
    // not the work.
    expect(U.suggestName({ title: 'Fix the checkout bug', cwd: '/Users/x/TomTom' }))
      .toBe('Fix the checkout bug')
  })
  it('keeps the first line and clips long prompts on a word boundary', () => {
    const long = 'Investigate why the tile cache stalls when the map view is backgrounded for a while'
    const out = U.suggestName({ title: `${long}\nsecond line`, cwd: '/x' })
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out).toBe('Investigate why the tile cache stalls when the map view is')
    expect(out).not.toContain('second line')
  })
  it('falls back to the cwd basename when there is no title', () => {
    expect(U.suggestName({ title: '', cwd: '/Users/x/my-repo' })).toBe('my-repo')
    expect(U.suggestName({ title: '   ', cwd: '/Users/x/my-repo' })).toBe('my-repo')
  })
})

describe('buildUnmanagedModel', () => {
  it('maps rows with relative time + default name', () => {
    const mtime = Math.floor(new Date('2026-07-22T10:00:00Z').getTime() / 1000) // 2h before NOW
    const m = U.buildUnmanagedModel([{ sessionId: 'a', title: 'Fix bug', cwd: '/Users/x/my-repo', mtime }], NOW)
    expect(m.empty).toBe(false)
    expect(m.rows).toHaveLength(1)
    // defaultName is the prompt, not the folder — see the suggestName tests above.
    expect(m.rows[0]).toMatchObject({ sessionId: 'a', title: 'Fix bug', cwd: '/Users/x/my-repo', defaultName: 'Fix bug' })
    expect(m.rows[0].when).toBe('2h ago')
  })
  it('falls back to "(untitled session)" and empty defaultName', () => {
    const m = U.buildUnmanagedModel([{ sessionId: 'b', title: '', cwd: '', mtime: 0 }], NOW)
    expect(m.rows[0].title).toBe('(untitled session)')
    expect(m.rows[0].defaultName).toBe('')
  })
  it('reports empty for no sessions', () => {
    expect(U.buildUnmanagedModel([], NOW)).toEqual({ empty: true, rows: [] })
  })
})

describe('unmanagedSectionHtml', () => {
  it('shows the loading state when expanded + loading', () => {
    const html = U.unmanagedSectionHtml({ expanded: true, loading: true, error: '', model: null })
    expect(html).toContain('Recent · unmanaged')
    expect(html).toContain('Loading')
  })
  it('shows the empty state', () => {
    const html = U.unmanagedSectionHtml({ expanded: true, loading: false, error: '', model: { empty: true, rows: [] } })
    expect(html).toContain('No unmanaged sessions')
  })
  it('renders a row with an Adopt button carrying sid + default name', () => {
    const model = { empty: false, rows: [{ sessionId: 'a', title: 'Fix bug', cwd: '/Users/x/my-repo', when: '2h ago', defaultName: 'my-repo' }] }
    const html = U.unmanagedSectionHtml({ expanded: true, loading: false, error: '', model })
    expect(html).toContain('data-adopt-sid="a"')
    expect(html).toContain('data-adopt-name="my-repo"')
    expect(html).toContain('Adopt')
  })
  it('escapes interpolated text', () => {
    const model = { empty: false, rows: [{ sessionId: 'a', title: '<img src=x>', cwd: '/x', when: '', defaultName: 'x' }] }
    const html = U.unmanagedSectionHtml({ expanded: true, loading: false, error: '', model })
    expect(html).not.toContain('<img src=x>')
    expect(html).toContain('&lt;img')
  })
  it('shows the error state with a retry control', () => {
    const html = U.unmanagedSectionHtml({ expanded: true, loading: false, error: 'boom', model: null })
    expect(html).toContain('boom')
    expect(html).toContain('data-unmanaged-refresh')
  })
})
