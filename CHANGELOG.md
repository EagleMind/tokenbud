# Changelog

All notable changes to tokenbud. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-19

First release.

- One desktop app with two modes: share your agent with an ID and password, or connect to someone else's.
- A web client served by the relay, so guests need nothing installed.
- Seats (how many people at once) and a reserve (an hourly limit, and pausing while you use it yourself).
- Local models (Ollama, LM Studio) and providers with your own API key: Anthropic, OpenAI, Google Gemini, Mistral, Groq, DeepSeek, xAI, OpenRouter, or any OpenAI-compatible server.
- Local-first memory: facts and chats stay on the guest's device, and the agent suggests facts to remember.
- `tokenbud mcp`: use a shared agent from your own coding agent.
- Light and dark themes. Set your own relay in Settings.

### Security
- The relay locks out wrong passwords per caller (IP address), not per host, so one person guessing can't block everyone else.
- An unknown ID and a wrong password now get the same answer, so IDs can't be probed.
- Host passwords are stored with salted PBKDF2 instead of plain SHA-256. Old hashes are replaced the next time the host connects.
- Per-IP rate limits on registering hosts and taking seats. Request bodies over 1.5 MB are refused.
- The host checks job IDs from the relay before using them in a folder name.
- The desktop app and the web client have a Content Security Policy: answers can't load outside images or scripts.
- The web client no longer keeps the password in the tab. A refresh resumes the seat with its session token.
- On Unix, the plain secrets file is readable only by you.

### Fixed
- A brief network or relay error no longer ends your session; the app retries instead.
- Being disconnected by the host, or a password change, now ends the session right away.
- Large answers are limited by size in bytes, so an answer near the limit can't get stuck.
- A damaged chats, memory or settings file is backed up and reported, instead of being silently replaced. Before, a damaged settings file could change the host's ID.
- Checking the engine or the reserve no longer holds up jobs and pings.
- Closing the window while connected no longer freezes it for a moment.
- Expired pauses no longer stop guests from sending.
- Chat titles and memory facts never cut an emoji in half.
- Connection errors no longer repeat themselves in the host's status.

### Changed
- Relay errors carry a machine-readable `code` next to the message.
- Old hosts with no connection for 30 days are cleaned up on the relay.
- Delete a chat or make a new password only after confirming.
- Keyboard and screen-reader improvements: reachable delete buttons, labelled controls, live status updates, and no accidental send while composing text in an IME.

### Added
- CI for pull requests: formatting, lints and tests for Rust, the frontend and the relay.
- Tests for the relay, the web client and the shared memory behaviour.
- `CONTRIBUTING.md`.

[Unreleased]: https://github.com/EagleMind/tokenbud/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/EagleMind/tokenbud/releases/tag/v0.1.0
