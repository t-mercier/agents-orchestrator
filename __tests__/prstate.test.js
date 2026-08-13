const P = require('../renderer/prstate')

const A = 'https://github.com/o/r/pull/1'
const B = 'https://github.com/o/r/pull/2'
const st = (m) => m

describe('stateOf', () => {
  it('reads a synced state', () => {
    expect(P.stateOf(st({ [A]: { state: 'merged' } }), A)).toBe('merged')
  })
  it('is unknown, never blank, for a PR never synced', () => {
    // Blank would read as "no PR here"; the truth is "we have not asked".
    expect(P.stateOf({}, A)).toBe('unknown')
  })
  it('is unknown for a state it does not recognise', () => {
    expect(P.stateOf(st({ [A]: { state: 'QUEUED' } }), A)).toBe('unknown')
  })
  it('survives a missing status map', () => {
    expect(P.stateOf(null, A)).toBe('unknown')
  })
})

describe('summaryState', () => {
  it('is unknown when the session has no PR', () => {
    expect(P.summaryState({}, [])).toBe('unknown')
  })
  it('speaks only when every PR agrees', () => {
    const s = st({ [A]: { state: 'merged' }, [B]: { state: 'merged' } })
    expect(P.summaryState(s, [A, B])).toBe('merged')
  })
  it('is mixed when they disagree — one icon cannot summarise three answers', () => {
    // Regression: a session with 3 PRs, one of them closed, showed a cross reading
    // "closed" while two were still open.
    const s = st({ [A]: { state: 'closed' }, [B]: { state: 'open' } })
    expect(P.summaryState(s, [A, B])).toBe('mixed')
  })
  it('counts an un-synced PR as a disagreement, not as a state to ignore', () => {
    const s = st({ [A]: { state: 'merged' } })
    expect(P.summaryState(s, [A, B])).toBe('mixed')
  })
  it('is unknown when nothing has been synced at all', () => {
    expect(P.summaryState({}, [A, B])).toBe('unknown')
  })
  it('does not depend on the order of the links', () => {
    const s = st({ [A]: { state: 'closed' }, [B]: { state: 'open' } })
    expect(P.summaryState(s, [A, B])).toBe(P.summaryState(s, [B, A]))
  })
  it('reports a lone PR as itself', () => {
    expect(P.summaryState(st({ [A]: { state: 'open' } }), [A])).toBe('open')
  })
})

describe('summaryOf', () => {
  it('agrees or says mixed', () => {
    expect(P.summaryOf(['open', 'open'])).toBe('open')
    expect(P.summaryOf(['open', 'merged'])).toBe('mixed')
  })
  it('is unknown for an empty set', () => expect(P.summaryOf([])).toBe('unknown'))
})

describe('vocabulary', () => {
  it('gives every state a glyph and a word, so colour never carries it alone', () => {
    for (const s of [...P.STATES, 'unknown']) {
      expect(P.GLYPH[s]).toBeTruthy()
      expect(P.WORD[s]).toBeTruthy()
    }
  })
  it('uses a distinct glyph per state', () => {
    const glyphs = Object.values(P.GLYPH)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })
})

describe('ticketFamily', () => {
  it('folds finished statuses onto the merged colour', () => {
    for (const s of ['Done', 'Resolved', 'Closed', 'Complete', 'Fixed'])
      expect(P.ticketFamily(s)).toBe('merged')
  })
  it('folds in-flight statuses onto the open colour', () => {
    for (const s of ['In Progress', 'In Review', 'Triaged', 'Blocked'])
      expect(P.ticketFamily(s)).toBe('open')
  })
  it('folds not-started statuses onto draft', () => {
    for (const s of ['To Do', 'Open', 'Backlog', 'New'])
      expect(P.ticketFamily(s)).toBe('draft')
  })
  it('folds abandoned statuses onto closed', () => {
    for (const s of ["Won't Do", 'Cancelled', 'Rejected', 'Duplicate'])
      expect(P.ticketFamily(s)).toBe('closed')
  })
  it('checks abandoned before finished, so "Won\'t Do" is not read as "Do"', () => {
    expect(P.ticketFamily("Won't Do")).toBe('closed')
  })
  it('is case- and space-insensitive', () => {
    expect(P.ticketFamily('  IN progress ')).toBe('open')
  })
  it('is unknown for a status it cannot place, and for nothing at all', () => {
    expect(P.ticketFamily('Pending Vendor')).toBe('unknown')
    expect(P.ticketFamily('')).toBe('unknown')
    expect(P.ticketFamily(null)).toBe('unknown')
  })
})

describe('ticketStateMap', () => {
  it('reads the YAML `ID: Status` entries the skills write', () => {
    expect(P.ticketStateMap(['GOSDK-1: In Review', 'GOSDK-2: Done']))
      .toEqual({ 'GOSDK-1': 'In Review', 'GOSDK-2': 'Done' })
  })
  it('keeps a status that itself contains a colon', () => {
    expect(P.ticketStateMap(['X-1: Blocked: waiting on SDK'])).toEqual({ 'X-1': 'Blocked: waiting on SDK' })
  })
  it('drops malformed entries instead of guessing', () => {
    expect(P.ticketStateMap(['no colon here', ': orphan', 'X-2: '])).toEqual({})
  })
  it('survives an absent list', () => expect(P.ticketStateMap(null)).toEqual({}))
})
