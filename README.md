# tokenbud

Share your AI agent the way you'd share your screen with TeamViewer. You open **tokenbud**, switch to **Share my agent**, and give someone your **ID** and **password**. They type both into tokenbud's **Connect to an agent** mode, or into the tokenbud web page with nothing to install, and chat with your agent. Your Claude login or API key never leaves your computer.

```
browser ──HTTPS──▶   relay (Cloudflare Worker + Durable Object)  ◀──WebSocket── tokenbud ──▶ your Claude
         ◀─answer──                                              ──answer─────▶
```

- **The host decides how many people at once.** Each connected person takes a seat. When every seat is taken, the next person is told to try again later. Each person has one prompt running at a time, so the seat count is also the maximum number of prompts running at once.
- **A new password disconnects everyone,** and so does stopping sharing. You can also disconnect one person.
- **No open ports.** The host app connects out to the relay.

## What's in the repo

| Path | What it is |
|---|---|
| `relay/` | Cloudflare Worker (TypeScript). Serves the web client at `/` and the API at `/v1`. One Durable Object per host holds its password hash, seats and sessions. |
| `crates/tokenbud-core` | Shared Rust code: wire types, relay client, config and keychain storage. |
| `apps/tokenbud-host` | Sharing logic and the two engines (Claude Code, API key). |
| `apps/tokenbud-client` | Connecting logic and the MCP server. |
| `apps/desktop` | **tokenbud**, the desktop app (Tauri): host and client modes in one window, plus `tokenbud mcp`. |
| `desktop/` | All the UI: React, Tailwind and shadcn/ui. `src/app` is the desktop window, `src/web` the browser client, `src/host` and `src/client` the two modes. |

## Run it

1. **Deploy the relay and the web client** (once, and after each change):

   ```bash
   cd desktop && npm install && cd ../relay && npm install
   npm run deploy        # builds the web client, then wrangler deploy
   ```

   Put the printed URL in `DEFAULT_RELAY_URL` (`crates/tokenbud-core/src/lib.rs`) before building. `TOKENBUD_RELAY` overrides it at run time.

2. **Build:** you need Rust and Node.js 20+.

   ```bash
   cd desktop && npm install && npm run build && cd ..
   cargo build --release
   ```

   The build produces `target/release/tokenbud`. `npm run bundle` in `desktop/` makes installers.

## Share (host mode)

Open **tokenbud** and click **Share my agent** at the top. Sharing starts the first time you open this mode; after that tokenbud remembers the mode and shares again whenever it opens there. A green dot on the switch means you're sharing, even while you're in the other mode.

- **People at the same time:** use − and + to set the number of seats (1–50, default 3). The list shows who is connected and who is prompting right now, with a **Disconnect** button for each person.
- The ↻ button next to the password makes a new one. The switch at the top stops sharing.
- Below that, one line says what answers and one summarises your reserve. **Change** opens Settings.

## Settings

The ⚙ button in the top bar opens Settings, in three sections.

**Model: where answers come from.**
- **This computer:** a local model in [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai), found automatically on their usual ports, or any OpenAI-compatible server address you enter. Pick the model, or leave it on the first available. It's free and private, and no provider's terms are involved.
- **A provider,** with your own API key: Anthropic, OpenAI, Google Gemini, Mistral, Groq, DeepSeek, xAI, OpenRouter, or **Custom** (any OpenAI-compatible API, such as vLLM or LiteLLM). Each provider keeps its own key in the OS keychain and its own model choice. The model list comes from the provider.
- **Claude Code (development builds only).** It runs `claude -p` on your own Claude Code login, for testing on your machine. Anthropic's terms don't allow answering other people's prompts with a Claude subscription, so release builds (`cargo build --release`, `npm run bundle`) leave this option out. It runs `claude -p --tools "" --strict-mcp-config --disallowedTools "mcp__*" --max-turns 10 --no-session-persistence` in an empty folder that is deleted afterwards.

Answers from reasoning models arrive without their `<think>` sections. The asker's memory is passed as a system message.

**Reserve: keep some for yourself.** Sharing pauses on its own so you never run short, and the people connected see when it resumes:
- **Lend at most N prompts an hour** (default 30, over a rolling 60 minutes). It also shows what you've lent, with Claude Code's cost estimate when there is one.
- **Pause while I'm using Claude Code** (only shown with the Claude Code engine). tokenbud notices Claude Code running on your computer, including the Claude desktop app's Code tab, and resumes when it stops. Its own prompts don't count.

**Appearance:** Light, Dark, or Match system.

## Connect (client mode)

In tokenbud, click **Connect to an agent**. Or open the relay's address in a browser (for example `https://tokenbud-relay.<you>.workers.dev`), or the link from the host's **Copy link** button, which fills in the ID. Enter the password (and, in the browser, your name), then click **Connect**. You can start as many chats as you like with **New chat**, and follow-ups keep the context of their chat. Chats are saved on your device (see Memory below), and a refresh keeps the connection. Closing the tab or clicking **Disconnect** frees your seat. A session that stops checking in ends after 45 seconds.

## Memory (local-first)

Your chats and a short list of facts about you ("Writes Rust", "Prefers short answers") are kept **only on your device**: in the config folder for the desktop app (`chats.json`, `memory.json`), and in the browser's IndexedDB for the web client.

- **Facts travel with each prompt** to the agent you're connected to, so it answers knowing you. Hosts and the relay never store them.
- **The agent can suggest a fact.** It ends its answer with a `<remember>…</remember>` tag, which shows up as a **Remember** / **Not now** chip. Nothing is saved until you accept it.
- **Open Memory** in the sidebar to add, edit or delete facts, or to switch memory off. When it's off, nothing is sent and the agent makes no suggestions.
- **Limits:** up to 50 facts and the 100 most recent chats.

## Appearance

Light, dark, or matching your system: in **Settings → Appearance** in the app, or from the sun/moon button on the web. The choice is remembered on each device.

## MCP: let your own agent use a shared one

The same executable runs as an MCP server, so Claude Code (or any MCP client) can prompt a shared agent:

```bash
claude mcp add tokenbud -e TOKENBUD_ID=418203977 -e TOKENBUD_PASSWORD=k7m2pqxa -- tokenbud mcp
```

It adds one tool, `ask(prompt)`. Each call takes a seat only while it runs.

## Security

- The relay stores only SHA-256 hashes of the host secret, the password and session tokens. After 10 wrong passwords in a minute, connecting to that host pauses.
- The relay sees prompts and answers in transit and deletes finished ones after 10 minutes. Run your own relay if that matters to you.
- Prompts run on your Claude account or API key and count against your limits or bill.

## Relay API

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/hosts` | none | New host. Returns `host_id` (9 digits) and `host_secret`. |
| `GET /v1/hosts/:id/connect` (WebSocket) | host secret | The host's channel. |
| `POST /v1/hosts/:id/sessions` `{password, name}` | none | Take a seat. Returns `session_token`. Errors: 401 wrong password, 409 no free seat, 503 not sharing. |
| `DELETE /v1/hosts/:id/sessions` | session | Leave. |
| `GET /v1/hosts/:id/ping` | session | Keep the seat (every 15s; 45s without one ends the session). Also returns `online` and `paused` (`{kind: "limit" \| "busy", until}` or null). |
| `POST /v1/hosts/:id/ask` `{prompt, history, context?}` | session | Send a prompt. `context` is the asker's memory (at most 10,000 chars), given to the agent before the prompt. Returns `job_id`. 409 if one is already running. |
| `GET /v1/hosts/:id/jobs/:job?wait=25` | session | The answer, with long-polling. |

On the WebSocket:
- **The host sends** `config {password, seats, name}`, `pause {paused}`, `kick {session_id}` and `result {job_id, status, text?, error?}`. While paused, the relay answers `ask` with 503.
- **The relay sends** `sessions`, `job` and `cancel`.

## Development

```bash
cd relay && npm run dev        # relay + web client on :8787; run the app with TOKENBUD_RELAY=http://127.0.0.1:8787
cd desktop && npm run app      # the desktop app with hot reload
cd desktop && npm run dev:web  # web client with hot reload on :1422 (proxies /v1 to :8787)
cd desktop && npm run preview:ui
# then open http://localhost:1430/preview.html (or ?connect=1 for the connect screen)
```

`TOKENBUD_HOME=/some/dir` keeps an instance's config in that folder, so you can run several on one machine.

To test without the desktop window, `cargo run -p tokenbud-host --example share` shares from a terminal and prints the ID and password. It's a dev harness only, not something that ships.
