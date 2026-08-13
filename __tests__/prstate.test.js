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

describe('sessionState', () => {
  it('is unknown when the session has no PR', () => {
    expect(P.sessionState({}, [])).toBe('unknown')
  })
  it('lets an open PR outrank a merged one', () => {
    // Open is the one that still needs you — it must survive the summary.
    const s = st({ [A]: { state: 'merged' }, [B]: { state: 'open' } })
    expect(P.sessionState(s, [A, B])).toBe('open')
  })
  it('prefers a known state over an un-synced one', () => {
    const s = st({ [A]: { state: 'merged' } })
    expect(P.sessionState(s, [A, B])).toBe('merged')
  })
  it('ranks draft below open but above closed and merged', () => {
    const s = st({ [A]: { state: 'draft' }, [B]: { state: 'closed' } })
    expect(P.sessionState(s, [A, B])).toBe('draft')
  })
  it('is unknown when nothing has been synced', () => {
    expect(P.sessionState({}, [A, B])).toBe('unknown')
  })
  it('does not depend on the order of the links', () => {
    const s = st({ [A]: { state: 'closed' }, [B]: { state: 'open' } })
    expect(P.sessionState(s, [A, B])).toBe(P.sessionState(s, [B, A]))
  })
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
