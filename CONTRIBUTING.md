# Contributing to tokenbud

Thanks for helping. tokenbud is a hobby project, maintained when time allows, so small and focused pull requests are the easiest to review. For anything bigger, open an issue first to talk it through.

## Setup

You need Rust 1.90 or later (the repo's `rust-toolchain.toml` picks stable for you) and Node.js 20 or later. On Linux, also the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
cd desktop && npm install && npm run build:app && cd ..
cd relay && npm install && cd ..
cargo build
```

The desktop app embeds the built frontend, so `npm run build:app` has to run once before `cargo` can compile `apps/desktop`. The README's Development section lists the dev servers.

## Before you send a change

CI runs these on every pull request. Run them locally first:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cd desktop && npx tsc --noEmit && npm test && npm run build
cd relay && npx tsc --noEmit && npm test
```

## Code style

- **Rust:** `cargo fmt` with the repo's `rustfmt.toml` (lines up to 140). Errors go through `anyhow`, except where callers need to decide something: the relay client returns a typed `RelayError`, and code decides on its `code`, never on message text.
- **TypeScript:** strict mode, no `any`. Format like the surrounding code (double quotes, semicolons, lines up to 140). Promises from UI actions go through `run()` in `src/lib/errors.ts`, so failures show up as a toast instead of disappearing.
- **Comments** say why, not what. Keep them short.
- **UI text** is plain and specific, in sentence case. Buttons say what they do ("Delete", not "OK").

## Things that must stay in step

- **Memory logic** exists twice: `apps/tokenbud-client/src/memory.rs` (desktop) and `desktop/src/client/backend.ts` (web). `tests/fixtures/memory.json` holds the expected behaviour, and both test suites check it. Change both, and the fixture, together.
- **Relay error codes** are defined in `relay/src/util.ts`, and matched in `crates/tokenbud-core/src/relay.rs` and `desktop/src/web/api.ts`.
- **Wire messages** between host and relay are in `crates/tokenbud-core/src/types.rs` and `relay/src/index.ts`.

## Releases

Bump `version` in the root `Cargo.toml` (and `desktop/package.json`), add a section to `CHANGELOG.md`, then push a matching tag. The release workflow checks that the tag and version agree, builds the installers, and attaches them to a draft release to review and publish.

```bash
git tag v0.1.0 && git push origin v0.1.0
```

If the relay changed, deploy it too: `npm run deploy` in `relay/`.
