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

describe('updateBannerText', () => {
  it('names both dates and the skills that would change', () => {
    const text = S.updateBannerText({ bundle_epoch: NEWER, installed_epoch: OLDER }, ['skills-review'])
    expect(text).toMatch(/newer version of the session skills is available/)
    expect(text).toContain('skills-review')
  })
})
