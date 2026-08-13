// Synthetic dataset + scene driver for scripts/screenshots/capture.sh.
//
// Stubs the Rust backend (window.__TAURI__) and feeds the real renderer a fake set of
// sessions, so docs/media/*.png can be regenerated without ever showing a real session.
// The session names and copy mirror the original screenshots, keeping the docs visually
// continuous across regenerations.
//
// Add a shot: add a scene here, then a `scene:file:w:h` line in capture.sh's SHOTS.
// The scene runs after the app has booted; window.__SHOT_READY__ flips when it is done.

const NOW = Date.now()
const mins = (n) => NOW - n * 60_000

// One root ⇒ no space sections, matching the flat category groups of the old shots.
const CONFIG = {
  home: '/Users/dev',
  roots: [{ name: 'Work', path: '/Users/dev/work' }],
  categories: [
    { name: 'FEAT', root: 'Work' }, { name: 'BUG', root: 'Work' },
    { name: 'REVIEW', root: 'Work' }, { name: 'CHORE', root: 'Work' },
    { name: 'TEST', root: 'Work' }, { name: 'PERSO', root: 'Work' },
  ],
  colorMap: { FEAT: '#7fc8a9', BUG: '#e08b7a', REVIEW: '#b39ddb', CHORE: '#e0c47a',
              TEST: '#8fb8d8', PERSO: '#c9a2d9' },
  ticketBaseUrl: 'https://jira.example.com/browse/',
  scanDirs: [{ base: '/Users/dev/work', root: 'Work' }],
}

const S = (o) => {
  const dir = `/Users/dev/work/${o.category}/${o.name}`
  return Object.assign({
    sessionId: o.name, notesPath: `${dir}/notes.md`, cwd: dir,
    state: 'active', status: 'idle', root: 'Work', entrypoint: 'cli',
    updatedAt: mins(3), lastActivityAt: mins(3), resumable: true,
  }, o)
}

const RUNNING = [
  S({ name: 'checkout-redesign', category: 'FEAT', ticket: 'FEAT-1842', status: 'waiting',
      gitBranch: 'feat/checkout-redesign', updatedAt: mins(1), lastActivityAt: mins(1),
      goal: 'Rebuild the checkout flow as a single-page step wizard with inline validation.',
      lastSummary: "I've added the wizard shell and the first two steps. Ready for you to confirm the express-pay placement before I wire the rest — left or right of the summary?",
      nextSteps: '1. Wire the address step to the new validation hook\n2. Add the express-pay buttons\n3. Smoke-test on mobile widths',
      prLink: 'https://github.com/acme/storefront/pull/1842',
      prLinks: ['https://github.com/acme/storefront/pull/1842', 'https://github.com/acme/storefront/pull/1851'],
      tickets: ['FEAT-1842', 'FEAT-1863'],
      ticketStates: ['FEAT-1842: In Review', 'FEAT-1863: In Progress'] }),
  S({ name: 'search-suggest', category: 'FEAT', ticket: 'FEAT-1907', status: 'waiting',
      gitBranch: 'feat/search-suggest', updatedAt: mins(6), lastActivityAt: mins(6),
      goal: 'Type-ahead suggestions on the catalogue search box.',
      lastSummary: 'The debounce is in. Should suggestions show recent searches too, or only catalogue matches?',
      nextSteps: '1. Debounce the query, then render the suggestion popover\n2. Keyboard nav through the results' }),
  S({ name: 'legacy-export', category: 'FEAT', ticket: 'FEAT-1790', state: 'stale', status: 'idle',
      gitBranch: 'feat/legacy-export', updatedAt: mins(3 * 1440), lastActivityAt: mins(3 * 1440),
      goal: 'Export the legacy reports as CSV for the finance team.',
      lastSummary: 'Export legacy reports as CSV.',
      nextSteps: '1. Map the remaining three column headers' }),
  S({ name: 'race-on-logout', category: 'BUG', ticket: 'BUG-2204', status: 'busy',
      gitBranch: 'fix/logout-race', updatedAt: mins(2), lastActivityAt: mins(2),
      goal: 'Session token is cleared before the in-flight request resolves.',
      lastSummary: 'Running the stress harness now — reproduced twice out of fifty runs.',
      nextSteps: '1. Reproduce with the new stress harness, then pin the ordering' }),
  S({ name: 'payments-api', category: 'REVIEW', ticket: 'REV-118', status: 'idle',
      gitBranch: 'review/payments-api', updatedAt: mins(11), lastActivityAt: mins(11),
      goal: 'Review the payments retry wrapper before it ships.',
      lastSummary: 'Summarised the diff. The retry wrapper looks solid, two edge cases to raise.',
      nextSteps: '1. Walk the retry path, then leave comments on the webhook handler',
      prLink: 'https://github.com/acme/storefront/pull/2091',
      ticketStates: ['REV-118: In Review'] }),
  S({ name: 'bump-deps', category: 'CHORE', status: 'busy',
      gitBranch: 'chore/q2-deps', updatedAt: mins(4), lastActivityAt: mins(4),
      goal: 'Quarterly dependency bump.',
      lastSummary: 'Upgraded 14 packages, rebuilding the lockfile.',
      nextSteps: '1. Run the test suite against the upgraded toolchain' }),
  S({ name: 'flaky-checkout-e2e', category: 'TEST', ticket: 'TEST-441', status: 'idle',
      gitBranch: 'test/checkout-e2e', updatedAt: mins(19), lastActivityAt: mins(19),
      goal: 'Stabilise the checkout end-to-end suite.',
      lastSummary: 'Down to one flaky spec.',
      nextSteps: '1. Replace the fixed sleeps with condition waits' }),
  S({ name: 'blog-engine', category: 'PERSO', status: 'idle',
      gitBranch: 'main', updatedAt: mins(37), lastActivityAt: mins(37),
      goal: 'Static blog generator for the personal site.',
      lastSummary: 'RSS feed generating. Next: tag pages.',
      nextSteps: '1. Generate the per-tag index pages' }),
]

const HISTORICAL = {
  stale: [],
  closed: [
    S({ name: 'invoice-pdf', category: 'FEAT', ticket: 'FEAT-1701', state: 'closed',
        historyStatus: 'closed', status: 'idle', updatedAt: mins(6 * 1440),
        lastSummary: 'Shipped the PDF renderer behind a flag; finance signed off.' }),
    S({ name: 'sitemap-gen', category: 'CHORE', state: 'closed', historyStatus: 'closed',
        status: 'idle', updatedAt: mins(9 * 1440),
        lastSummary: 'Sitemap regenerates nightly on the cron worker.' }),
  ],
  archived: [
    S({ name: 'old-admin-theme', category: 'CHORE', state: 'archived', historyStatus: 'archived',
        status: 'idle', updatedAt: mins(40 * 1440),
        lastSummary: 'Abandoned — the admin is moving to the shared design system.' }),
  ],
}

// Board: the same five custom columns, group and notes as the previous shot.
const KANBAN = {
  columns: [
    { id: 'todo', name: 'To do' }, { id: 'doing', name: 'In progress' },
    { id: 'review', name: 'In review' }, { id: 'waiting', name: 'Waiting on me' },
    { id: 'shipped', name: 'Shipped' },
  ],
  placements: {
    '/Users/dev/work/FEAT/search-suggest/notes.md': 'todo',
    '/Users/dev/work/FEAT/legacy-export/notes.md': 'todo',
    '/Users/dev/work/BUG/race-on-logout/notes.md': 'doing',
    '/Users/dev/work/TEST/flaky-checkout-e2e/notes.md': 'doing',
    '/Users/dev/work/CHORE/bump-deps/notes.md': 'doing',
    '/Users/dev/work/PERSO/blog-engine/notes.md': 'doing',
    '/Users/dev/work/REVIEW/payments-api/notes.md': 'review',
    '/Users/dev/work/FEAT/checkout-redesign/notes.md': 'waiting',
  },
  // A group is a column entry referenced as 'g:<id>'; its members live in order['g:<id>'].
  groups: [{ id: 'grp-checkout', name: 'Checkout hardening', columnId: 'doing', collapsed: false }],
  notes: [
    { id: 'n-1', text: 'PR #1842 open — reviewer pinged.', columnId: 'waiting',
      parent: '/Users/dev/work/FEAT/checkout-redesign/notes.md' },
    { id: 'n-2', text: 'Blocked on design sign-off for the summary column.', columnId: 'waiting' },
  ],
  urgent: ['/Users/dev/work/BUG/race-on-logout/notes.md'],
  order: {
    doing: ['g:grp-checkout', '/Users/dev/work/CHORE/bump-deps/notes.md',
            '/Users/dev/work/PERSO/blog-engine/notes.md'],
    'g:grp-checkout': ['/Users/dev/work/BUG/race-on-logout/notes.md',
                       '/Users/dev/work/TEST/flaky-checkout-e2e/notes.md'],
  },
  colorSeed: '#7E93B8', colorScheme: 'spectrum',
}

const USAGE = {
  model: 'Opus 5', fiveHourPct: 38, weeklyPct: 54,
  fiveHourResetAt: NOW + 2 * 3600_000, weeklyResetAt: NOW + 3 * 86400_000,
  sessions: { 'checkout-redesign': { model: 'Opus 5', contextPct: 41 } },
}

// ── Backend stub ───────────────────────────────────────────────────────────────
const RESULTS = {
  get_config: CONFIG,
  get_sessions: RUNNING,
  get_historical_sessions_all: HISTORICAL,
  get_usage: USAGE,
  skills_status: { installed: true, missing: [] },
  can_reveal_terminal: false,
  discover_sessions: [],
  notes_closed_since: false,
  // What a Sync would have left behind. Synthetic like the rest — no network here.
  get_pr_status: {
    'https://github.com/acme/storefront/pull/1842': {
      state: 'merged', title: 'feat(checkout): single-page wizard shell', checkedAt: '2026-08-13 14:05',
    },
    'https://github.com/acme/storefront/pull/1851': {
      state: 'open', title: 'feat(checkout): express-pay buttons', checkedAt: '2026-08-13 14:05',
    },
    'https://github.com/acme/storefront/pull/2091': {
      state: 'open', title: 'fix(payments): retry the webhook on a 5xx', checkedAt: '2026-08-13 14:05',
    },
  },
}
window.__PTY_HANDLERS__ = {}
window.__TAURI__ = {
  core: {
    invoke: (cmd, args) => {
      if (cmd === 'get_historical_sessions') return Promise.resolve(HISTORICAL[args.status] || [])
      if (cmd === 'pty_spawn') return Promise.resolve(null)
      return Promise.resolve(cmd in RESULTS ? RESULTS[cmd] : null)
    },
  },
  event: {
    listen: (name, cb) => { (window.__PTY_HANDLERS__[name] ||= []).push(cb); return Promise.resolve(() => {}) },
  },
  window: { getCurrentWindow: () => ({ setAlwaysOnTop: () => Promise.resolve(true) }) },
}

// Preferences the scenes rely on (read at boot from localStorage).
try {
  localStorage.clear()
  localStorage.setItem('csm.kanban', JSON.stringify(KANBAN))
  localStorage.setItem('csm.density', 'detailed')
} catch { /* ignore */ }

document.documentElement.dataset.theme = 'dark'

// ── Scenes ─────────────────────────────────────────────────────────────────────
const scene = new URLSearchParams(location.search).get('scene') || 'list'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const click = (sel) => { const e = document.querySelector(sel); if (e) e.click(); return !!e }

async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(50) }
  return false
}

const applyLook = (id) => {
  const L = (window.CSM_LOOKS || []).find(l => l.id === id)
  if (!L || !window.applyLook) return
  window.applyLook(L.accent, L.tint, L.tintA, L.id)
}

const SCENES = {
  // hero.png — List view, a waiting session selected, detail pane filled.
  async list() {
    await waitFor(() => document.querySelector('#panel-list .list-card'))
    click('#panel-list .list-card[data-key$="checkout-redesign/notes.md"]')
    await sleep(250)
  },
  // light.png — same, light theme.
  async light() {
    await SCENES.list()
    document.documentElement.dataset.theme = 'light'
    await sleep(250)
  },
  // look-rose.png — same, "Rose Poudré" look.
  async rose() {
    await SCENES.list()
    applyLook('rose-poudre')
    await sleep(250)
  },
  // board.png — the kanban, groups + notes + an urgent flag.
  async board() {
    await waitFor(() => document.querySelector('#panel-list .list-card'))
    window.setViewMode('board')
    await waitFor(() => document.querySelector('#board-view .kb-col'))
    await sleep(400)
  },
  // settings.png — Settings → Appearance, over the board.
  async settings() {
    await SCENES.board()
    click('#settings-btn')
    await waitFor(() => document.querySelector('.settings-tab'))
    click('.settings-tab[data-settings-tab="appearance"]')
    await sleep(400)
  },
  // terminal.png — the embedded xterm pane, fed through the real pty-data path.
  async terminal() {
    await SCENES.list()
    const sid = 'checkout-redesign'
    const notes = '/Users/dev/work/FEAT/checkout-redesign/notes.md'
    window.toggleEmbeddedTerminal(sid, '/Users/dev/work/FEAT/checkout-redesign', '', notes)
    await waitFor(() => document.querySelector('.xterm-rows'))
    const D = '\x1b[2m', C = '\x1b[36m', G = '\x1b[32m', B = '\x1b[1m', R = '\x1b[0m'
    const out = [
      `${D}~/work/FEAT/checkout-redesign${R}  ${D}(feat/checkout-redesign)${R}`,
      `$ claude --resume`,
      ``,
      `${G}●${R} ${B}Claude${R}  ${D}resuming "checkout-redesign" — 2 steps done${R}`,
      ``,
      `  ${B}Plan${R}`,
      `  ${G}✔${R} Wizard shell + step container`,
      `  ${G}✔${R} Address step with inline validation`,
      `  ${D}○ Express-pay buttons${R}`,
      `  ${D}○ Mobile-width smoke test${R}`,
      ``,
      `  ${C}●${R} ${C}Read${R}  src/checkout/Wizard.tsx ${D}(148 lines)${R}`,
      `  ${C}●${R} ${C}Edit${R}  src/checkout/steps/Address.tsx`,
      ``,
      `  I've wired the address step to the new validation hook. Before I add`,
      `  the express-pay buttons — left or right of the order summary?`,
      ``,
      `${C}❯${R} `,
    ].join('\r\n')
    for (const cb of (window.__PTY_HANDLERS__['pty-data'] || [])) {
      cb({ payload: { sessionId: sid, data: out } })
    }
    await sleep(600)
  },
}

;(async () => {
  try {
    await (SCENES[scene] || SCENES.list)()
  } catch (e) {
    window.__SHOT_ERROR__ = String(e && e.message || e)
  }
  // The app polls every 5s; with timers still pending Chrome's virtual-time budget
  // never drains and --screenshot never fires. Freeze the page once the scene is set.
  const hiId = setTimeout(() => {}, 0)
  for (let i = 1; i <= hiId; i++) { clearTimeout(i); clearInterval(i) }
  window.__SHOT_READY__ = true
})()
