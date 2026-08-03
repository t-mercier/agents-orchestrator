# Contributing

Thanks for your interest! 🙏

## How to help right now

**Issues and suggestions are very welcome** — bug reports, feature ideas, papercuts, "this felt off" notes. They genuinely shape the roadmap.

- 🐛 **Bugs:** what you did, what happened, what you expected. Your OS and version (macOS or Linux) + a screenshot help a lot.
- 💡 **Ideas / UX feedback:** open an issue and describe the problem you're hitting — not just a proposed solution.

## About code contributions

This is an opinionated, design-led project that I maintain **solo**, so I keep tight control over the direction and the UX. That said, I **do accept well-scoped pull requests on a case-by-case basis** — especially infrastructure and cross-platform work (Linux support landed as an external PR).

A couple of ground rules keep things coherent:

1. **Open an issue before writing any code.** Let's agree on the shape of a change first — it saves us both a wasted PR. UX/UI changes in particular I'll usually want to drive myself.
2. **Sign off your commits** (`git commit -s`, [DCO](https://developercertificate.org/)) so the provenance of contributed code is clear and the licensing stays clean.

**Good fits:** cross-platform support, CI/build tooling, bug fixes with a clear repro, performance. **Harder sells:** large UX/visual reworks, or new top-level features that haven't been discussed first.

## License

The project is under the [AI Agents Orchestrator Source Available License v1.0](LICENSE) — free to use and evaluate (including at work); reselling, redistributing, org-wide deployment, or SaaS offerings need written permission. By opening an issue you're just sharing feedback; nothing here asks you to assign rights.

## If you're poking around the code

A few notes so the project stays coherent:

- **Stack:** [Tauri v2](https://tauri.app) (Rust backend + system WebView) with a **vanilla-JS** renderer — no framework. Pure logic lives in `renderer/lib/*` (UMD modules, unit-tested); DOM templates + event delegation live in `ui.js`.
- **Run it:** `cargo tauri dev`. **Tests:** `npm test` (Jest, renderer logic) and `cargo test` (in `src-tauri/`, Rust).
- **Read-only by design.** The app never writes to `~/.claude` except a few explicit, sandboxed actions (archive, PR links, tickets). The Rust command surface is small and every input is allowlist-validated (absolute paths, safe branches, `github.com/owner/repo/pull/N`), commands are spawned argv-only (no shell strings), and the core is **zero-network**.
- **Screenshots are generated.** `docs/media/*.png` comes from [`scripts/screenshots/capture.sh`](scripts/screenshots/capture.sh) — it drives the real renderer with a synthetic dataset, so no real session ends up in the docs. Re-run it after a UI change that alters what the docs show.
- **Architecture decisions** live in [`docs/adr`](docs/adr). Anything that adds a Tauri command, touches the PTY layer, or introduces a network call would need an ADR + a security rationale.

These keep the bar clear in case the project opens to code contributions down the line.
