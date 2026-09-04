const C = require('../renderer/lib/clean-model')

const NOW = Date.parse('2026-09-04T12:00:00Z')
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString()
const s = (state, over) => ({ state, notesPath: `/n/${state}-${Math.random()}`, ...over })

describe('ageInDays', () => {
  it('uses the more recent of the notes mtime and the transcript', () => {
    // updatedAt is stale (a save from long ago); the transcript was touched yesterday.
    const row = s('closed', { updatedAt: NOW - 40 * 86400000, lastActivityAt: daysAgo(1) })
    expect(C.ageInDays(row, NOW)).toBe(1)
  })

  it('falls back to the notes mtime when the transcript is gone', () => {
    expect(C.ageInDays(s('closed', { updatedAt: NOW - 12 * 86400000 }), NOW)).toBe(12)
  })

  it('is null — not zero — when nothing dates the session', () => {
    expect(C.ageInDays(s('closed'), NOW)).toBeNull()
  })
})

describe('audit', () => {
  it('proposes archiving closed and stale work past the threshold', () => {
    const rows = [s('closed', { updatedAt: NOW - 45 * 86400000 }), s('stale', { updatedAt: NOW - 31 * 86400000 })]
    const out = C.audit(rows, { now: NOW, archiveAfterDays: 30 })
    expect(out.toArchive.map(r => r.ageDays)).toEqual([45, 31])
    expect(out.toDelete).toHaveLength(0)
  })

  it('leaves work younger than the threshold alone', () => {
    const out = C.audit([s('closed', { updatedAt: NOW - 29 * 86400000 })], { now: NOW, archiveAfterDays: 30 })
    expect(out.toArchive).toHaveLength(0)
  })

  it('only ever proposes deleting sessions that are already archived', () => {
    const rows = [
      s('archived', { updatedAt: NOW - 200 * 86400000 }),
      s('closed', { updatedAt: NOW - 200 * 86400000 }),
      s('stale', { updatedAt: NOW - 200 * 86400000 }),
    ]
    const out = C.audit(rows, { now: NOW, archiveAfterDays: 30, deleteAfterDays: 90 })
    expect(out.toDelete).toHaveLength(1)
    expect(out.toDelete[0].session.state).toBe('archived')
    expect(out.toArchive.every(r => r.session.state !== 'archived')).toBe(true)
  })

  it('never proposes archiving something already archived', () => {
    const out = C.audit([s('archived', { updatedAt: NOW - 45 * 86400000 })], { now: NOW, archiveAfterDays: 30, deleteAfterDays: 90 })
    expect(out.toArchive).toHaveLength(0)
    expect(out.toDelete).toHaveLength(0)   // 45 days is past archiving, not past deleting
  })

  it('counts undated sessions instead of proposing anything for them', () => {
    const out = C.audit([s('closed'), s('archived')], { now: NOW })
    expect(out.undated).toBe(2)
    expect(out.toArchive).toHaveLength(0)
    expect(out.toDelete).toHaveLength(0)
  })

  it('sorts each group oldest first', () => {
    const rows = [
      s('closed', { updatedAt: NOW - 40 * 86400000 }),
      s('closed', { updatedAt: NOW - 90 * 86400000 }),
      s('closed', { updatedAt: NOW - 60 * 86400000 }),
    ]
    expect(C.audit(rows, { now: NOW, archiveAfterDays: 30 }).toArchive.map(r => r.ageDays)).toEqual([90, 60, 40])
  })

  it('handles an empty or missing list', () => {
    expect(C.audit([], { now: NOW }).toArchive).toHaveLength(0)
    expect(C.audit(undefined, { now: NOW }).toDelete).toHaveLength(0)
  })
})
