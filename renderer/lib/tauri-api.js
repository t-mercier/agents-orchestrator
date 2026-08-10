// Tauri ⇄ renderer bridge: recreates the `window.api` the Electron preload used,
// backed by Tauri's invoke (window.__TAURI__ is global thanks to withGlobalTauri).
// Loaded FIRST so ui.js/app.js find window.api ready.
;(function () {
  const { invoke } = window.__TAURI__.core

  window.api = {
    // ── Implemented in Rust (src-tauri/src/{config,reader,lib}.rs) ──
    getConfig: () => invoke('get_config'),
    setConfig: (cfg) =>
      invoke('set_config', { cfg }).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: String(e) })),
    // Native folder picker for Settings; resolves to the chosen path or null (cancelled).
    pickDirectory: () => invoke('pick_directory').catch(() => null),
    // Native multi-folder picker → array of absolute paths (empty if cancelled).
    pickDirectories: () => invoke('pick_directories').catch(() => []),
    exportSettings: (json) => invoke('export_settings', { json }).then((saved) => ({ ok: true, saved })).catch((e) => ({ ok: false, error: String(e) })),
    importSettings: () => invoke('import_settings').then((content) => ({ ok: true, content })).catch((e) => ({ ok: false, error: String(e) })),
    getSessions: () => invoke('get_sessions'),
    getHistoricalSessions: (status) => invoke('get_historical_sessions', { status }),
    // All three lifecycle buckets ({stale, closed, archived}) from ONE backend scan —
    // for callers that need every bucket at once (badge seed, board index).
    getHistoricalAll: () => invoke('get_historical_sessions_all'),
    // Unmanaged transcripts (no notes.md) for the "Import a session" picker.
    discoverSessions: () => invoke('discover_sessions'),
    // Never let a rejected open (unsupported scheme) become an unhandled promise
    // rejection — that made a link click look like it did nothing at all.
    openExternal: (url) =>
      invoke('open_external', { url })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: String(e) })),
    openPath: (p) => invoke('open_path', { path: p }),
    openInTerminal: (cwd, sessionId) => invoke('open_in_terminal', { cwd: cwd || '', sessionId }),
    // Reveal an already-open session window: canReveal gates whether we offer the button.
    canRevealTerminal: (pid) => invoke('can_reveal_terminal', { pid: pid || 0 }).catch(() => false),
    revealTerminal: (pid) =>
      invoke('reveal_terminal', { pid: pid || 0 }).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: String(e) })),

    // ── Embedded terminal (src-tauri/src/pty.rs) ──
    // command (optional): a full shell command from start_session(embedded=true), run
    // verbatim to CREATE a new session in this pty; sessionId is then its notesPath.
    ptySpawn: (sessionId, cwd, cols, rows, restartSlug, command) =>
      invoke('pty_spawn', { sessionId, cwd, cols: cols || 0, rows: rows || 0, restartSlug: restartSlug || '', command: command || '' }),
    ptyInput: (sessionId, data) => invoke('pty_input', { sessionId, data }),
    ptyResize: (sessionId, cols, rows) => invoke('pty_resize', { sessionId, cols, rows }),
    ptyKill: (sessionId) => invoke('pty_kill', { sessionId }),
    onPtyData: (cb) => window.__TAURI__.event.listen('pty-data', (e) => cb(e.payload.sessionId, e.payload.data)),
    onPtyExit: (cb) => window.__TAURI__.event.listen('pty-exit', (e) => cb(e.payload.sessionId)),

    // ── New-session launcher (src-tauri/src/lib.rs) ──
    // embedded=false (default): launches an external iTerm tab, returns { ok }.
    // embedded=true: launches NOTHING — returns { ok, command, notesPath } so the renderer
    // can run the command in an in-app pty keyed by notesPath.
    startSession: ({ category, name, ticket, repo, branch, prLink, root, embedded } = {}) =>
      invoke('start_session', {
        category: category || '', name: name || '', ticket: ticket || '',
        repo: repo || '', branch: branch || '', prLink: prLink || '', root: root || '',
        embedded: !!embedded,
      })
        .then((res) => ({ ok: true, ...(res || {}) }))
        .catch((e) => ({ ok: false, error: String(e) })),

    // ── Set / update / clear a session's PR links (notes.md frontmatter) ──
    // A session can carry several PRs (one task split across two of them). The first
    // entry becomes the primary `pr_link:`, the rest a `pr_links:` list; [] clears both.
    setPrLinks: (notesPath, urls) =>
      invoke('set_pr_links', { notesPath: notesPath || '', urls: urls || [] })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: String(e) })),

    // ── Same, for the tracker side: `ticket:` + `tickets:` ──
    setTickets: (notesPath, tickets) =>
      invoke('set_tickets', { notesPath: notesPath || '', tickets: tickets || [] })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: String(e) })),

    // ── Archive a closed session (stamps notes.md + drops it from active-sessions) ──
    archiveSession: (notesPath) =>
      invoke('archive_session', { notesPath: notesPath || '' })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: String(e) })),
    unarchiveSession: (notesPath) =>
      invoke('unarchive_session', { notesPath: notesPath || '' })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: String(e) })),

    // ── Delete an archived session: move its folder to the OS Trash (recoverable) ──
    deleteSession: (notesPath) =>
      invoke('delete_session', { notesPath: notesPath || '' })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: String(e) })),

    // ── Reopen a closed/archived session via /restart (src-tauri/src/lib.rs) ──
    restoreSession: (slug, sessionId) =>
      invoke('restore_session', { slug: slug || '', sessionId: sessionId || '' })
        .then(() => ({ ok: true }))
        .catch((e) => ({ ok: false, error: String(e) })),

    // ── Import an existing (unmanaged) session: --resume it + run /import to adopt it ──
    // root (optional): which space it lands under (when >1). embedded=true launches NOTHING
    // and returns { ok, command } to run in an in-app pty; else it opens an external tab.
    importSession: (sessionId, category, name, root, embedded) =>
      invoke('import_session', { sessionId: sessionId || '', category: category || '', name: name || '', root: root || '', embedded: !!embedded })
        .then((res) => ({ ok: true, ...(res || {}) }))
        .catch((e) => ({ ok: false, error: String(e) })),

    // ── Has the session's notes.md been freshly /close-session'd since `since` (ms)? ──
    // Polled by the embedded "End session" button after it injects /close-session, to
    // know when the AI wrap-up has been written (then it kills the pty).
    notesClosedSince: (notesPath, since) =>
      invoke('notes_closed_since', { notesPath: notesPath || '', sinceMs: since || 0 }).catch(() => false),
    // Stamp a close marker directly into notes.md (guaranteed-close fallback when
    // /close-session produced no fresh wrap-up). Moves the session to Closed.
    closeSession: (notesPath) =>
      invoke('close_session', { notesPath: notesPath || '' }).then(() => ({ ok: true })).catch((e) => ({ ok: false, error: String(e) })),

    // ── Session skills installer (src-tauri/src/skills.rs) ──
    // status: which bundled skills are already in ~/.claude/skills (drives the banner).
    skillsStatus: () => invoke('skills_status').catch(() => ({ installed: true, present: [], missing: [], differs: [] })),
    // install(force): copy bundled skills → ~/.claude/skills (force overwrites existing),
    // seed a default config if absent, pre-create category folders. Returns the report.
    installSkills: (force) =>
      invoke('install_skills', { force: !!force })
        .then((r) => ({ ok: true, ...(r || {}) }))
        .catch((e) => ({ ok: false, error: String(e) })),

    // ── Detach into its own window + pin (src-tauri/src/lib.rs) ──
    detachSession: (key) => invoke('detach_session', { key }),
    setAlwaysOnTop: (flag) => invoke('set_always_on_top', { flag }).catch(() => false),
    // Match the native window background to the theme (avoids a white flash on resize).
    setWindowBg: (dark) => invoke('set_window_bg', { dark: !!dark }).catch(() => {}),

    // ── Usage status bar (Claude Code statusline cache) ──
    // Fetches ~/.claude/statusline-cache.json; returns the parsed object or null (cache absent/unreadable).
    getUsage: (sessionId) => invoke('get_usage', { sessionId }).catch(() => null),
  }
})()
