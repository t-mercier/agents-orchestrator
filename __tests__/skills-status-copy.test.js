const S = require('../renderer/lib/skills-status-copy')

describe('syncResultText', () => {
  it('names installed, updated and backed-up skills, with the backup location', () => {
    const text = S.syncResultText({
      skipped_ahead: false,
      installed: ['lib', 'new-one'],
      updated: ['close-session', 'start-session'],
      backed_up: [{ name: 'start-session', backup: '/x/.archive/start-session.pre-sync-1' }],
    })
    expect(text).toContain('Installed 1 new skill: new-one.')
    expect(text).not.toContain('lib') // filtered out — not a slash-command skill
    expect(text).toContain('Updated 2 to this app version: close-session, start-session.')
    expect(text).toContain('Your edited copy of start-session was kept in ~/.claude/skills/.archive/.')
  })

  it('pluralises the backed-up sentence', () => {
    const text = S.syncResultText({
      installed: [],
      updated: ['a', 'b'],
      backed_up: [{ name: 'a', backup: '/x' }, { name: 'b', backup: '/y' }],
    })
    expect(text).toContain('Your edited copies of a, b were kept')
  })

  it('reports a stood-down sync as such, not as "up to date"', () => {
    // skipped_ahead is the developer case: install.sh ran after this app was built.
    // "Already up to date" would be wrong — the disk is AHEAD, not merely current.
    const text = S.syncResultText({ skipped_ahead: true, installed: [], updated: [], backed_up: [] })
    expect(text).toMatch(/already at \(or past\) this app version/)
  })

  it('says "already up to date" when nothing happened', () => {
    expect(S.syncResultText({ installed: ['lib'], updated: [], backed_up: [] }))
      .toBe('Already up to date.')
  })

  it('tolerates missing fields entirely', () => {
    expect(S.syncResultText({})).toBe('Already up to date.')
  })
})
