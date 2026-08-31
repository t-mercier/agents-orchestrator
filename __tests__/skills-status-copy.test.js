const S = require('../renderer/lib/skills-status-copy')

const OLDER = 1_700_000_000
const NEWER = 1_800_000_000

describe('compareEpochs', () => {
  it('is newer when the bundle post-dates the last stamp', () => {
    const cmp = S.compareEpochs({ bundle_epoch: NEWER, installed_epoch: OLDER })
    expect(cmp).toMatchObject({ known: true, isNewer: true, isOlderOrSame: false })
  })

  it('is older-or-same when the bundle does not post-date the last stamp', () => {
    expect(S.compareEpochs({ bundle_epoch: OLDER, installed_epoch: NEWER }))
      .toMatchObject({ known: true, isNewer: false, isOlderOrSame: true })
    expect(S.compareEpochs({ bundle_epoch: OLDER, installed_epoch: OLDER }))
      .toMatchObject({ known: true, isNewer: false, isOlderOrSame: true })
  })

  it('is unknown when the bundle epoch is 0 (no .git at build time)', () => {
    expect(S.compareEpochs({ bundle_epoch: 0, installed_epoch: OLDER }))
      .toMatchObject({ known: false, isNewer: false, isOlderOrSame: false })
  })

  it('is unknown when nothing was ever stamped', () => {
    expect(S.compareEpochs({ bundle_epoch: NEWER, installed_epoch: null }))
      .toMatchObject({ known: false, isNewer: false, isOlderOrSame: false })
  })

  it('is unknown when the status object itself is missing fields entirely', () => {
    expect(S.compareEpochs({})).toMatchObject({ known: false })
    expect(S.compareEpochs(null)).toMatchObject({ known: false })
  })
})

describe('overwriteDialog', () => {
  const present = ['skills-review', 'learn']
  const differs = ['skills-review']

  it('warns "go backward" when the bundle is not newer', () => {
    const status = { bundle_epoch: OLDER, installed_epoch: NEWER }
    const { title, body } = S.overwriteDialog(status, present, differs)
    expect(title).toBe('This would go backward')
    expect(body).toMatch(/OLDER bundled versions/)
    expect(body).toContain('skills-review')
  })

  it('reassures "is newer" when the bundle really is ahead', () => {
    const status = { bundle_epoch: NEWER, installed_epoch: OLDER }
    const { title, body } = S.overwriteDialog(status, present, differs)
    expect(title).toBe('Overwrite session skills?')
    expect(body).toMatch(/is newer than what's on disk/)
  })

  it('falls back to the neutral wording when dates are unknown', () => {
    const status = { bundle_epoch: 0, installed_epoch: null }
    const { title, body } = S.overwriteDialog(status, present, differs)
    expect(title).toBe('Overwrite session skills?')
    expect(body).not.toMatch(/backward|is newer than/)
  })

  it('always names the present skills and the ones that actually differ', () => {
    const { body } = S.overwriteDialog({ bundle_epoch: 0, installed_epoch: null }, present, differs)
    expect(body).toContain('skills-review, learn')
    expect(body).toMatch(/your changes would be lost: skills-review/)
    expect(body).toMatch(/Your other skills are not touched/)
  })

  it('omits the diff note entirely when nothing differs', () => {
    const { body } = S.overwriteDialog({ bundle_epoch: 0, installed_epoch: null }, present, [])
    expect(body).not.toMatch(/would be lost/)
  })
})

describe('updateResultText', () => {
  it('names installed, updated, kept-local and conflicting skills', () => {
    const text = S.updateResultText({
      installed: ['lib', 'new-one'],
      updated: ['close-session'],
      kept_local: ['start-session'],
      conflicts: ['skills-review'],
    })
    expect(text).toContain('Installed 1 new skill: new-one.')
    expect(text).not.toContain('lib') // filtered out — not a slash-command skill
    expect(text).toContain('Updated 1 from upstream: close-session.')
    expect(text).toContain('Kept your own changes to 1, not touched: start-session.')
    expect(text).toContain('both your changes and an upstream update')
    expect(text).toContain('skills-review')
  })

  it('says "already up to date" when nothing happened', () => {
    expect(S.updateResultText({ installed: ['lib'], updated: [], kept_local: [], conflicts: [] }))
      .toBe('Already up to date.')
  })

  it('tolerates missing fields entirely', () => {
    expect(S.updateResultText({})).toBe('Already up to date.')
  })
})
