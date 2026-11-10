# Hob

Hob is a self-hosted personal assistant that gets work done: talk to Hob, and it handles small requests itself and delegates larger jobs.

[中文说明](README.zh-CN.md) · [Architecture](docs/architecture.md) · MIT License

> The interface is currently Chinese-only. Hob is a single-user app you run on your own machine or server.

![Hob: chat with the main assistant, a running job and its live transcript](docs/screenshots/chat.png)

## How it works

You talk to assistants, not jobs. An assistant handles small requests directly and delegates larger work to a job. Jobs return Markdown results and files only to their assistant, and ask the assistant when they need an answer; the assistant decides what to show you and when to ask you. Global rules and each assistant's own rules determine what needs your confirmation.

## What you get

### Assistants, jobs and schedules

Each assistant has a conversation, duties, rules, skills, schedules and a work log. When similar requests recur, Hob can propose a dedicated assistant. When it delegates to another assistant, a delegation card tracks the work, carries your original request and lets you take over in the receiving assistant's conversation.

Jobs can be inspected, stopped or resumed, with each round retained; the assistant receives reminders when a job exceeds its expected duration. Routines put their job cards and results in the conversation. A routine can run once at a set time, or carry a check script that runs first and wakes the assistant (or just leaves you a note) only when something changed, optionally stopping after the first hit. The conversation follows new output as the assistant writes; screenshots can be pasted and files dropped straight into the window.

On a phone, the assistant list, conversation and profile use a mobile layout; the app supports swipe-to-reply and long-press actions. Push notifications alert you when an assistant needs your decision or a job gets stuck or fails.

![Hob on a phone: assistant list, a delegation card and assistant settings](docs/screenshots/mobile.png)

### Skills

An assistant decides which of its skills each job gets; a schedule can be bound to one. When a job finishes something worth repeating, the assistant has that job write the skill up in its own session, running the commands and scripts again first. Skills covering the same kind of work are merged into one and the older copy archived; when a job finds a step outdated, the skill gets corrected.

### Rules

Global rules apply to every assistant and job; each assistant can also have its own. Rules distinguish actions that require confirmation from instructions to follow automatically; confirmation choices can save an exception for next time.

### Pages and knowledge

Assistants can present comparisons and research as pages in the side panel. Organize, search and preview files in knowledge bases, bind them to assistants and follow citations; optional embeddings enable hybrid search, including indexed PDF text.

### Cloud desktop and tools

An optional cloud desktop gives each assistant a browser and screen shared with its jobs; selected assistants can also use a public screen. Assistants can operate the browser and send screenshots in chat; you can watch or take control.

Assistants and jobs can use web search across SearXNG, Exa, Tavily, Brave, Serper, Jina, Firecrawl, Perplexity, You.com and Ollama. Jobs can call configured MCP services, including configurations imported from Claude Code, Cursor and pi. Memory can be local or use [Lore](https://github.com/FFatTiger/lore); image generation uses an OpenAI-compatible API. npm and source installations can also use an existing Claude Code subscription login.

### Usage and cost

Settings → Usage counts the conversations and jobs you already have and shows requests, tokens and estimated cost for the last day, 7 days, 30 days or all time, with a heatmap for the past year and breakdowns by model and by assistant. Prices come from models.dev by default and can be edited per model.

### Light and dark

Hob has light and dark themes and can follow the system setting.

## Quick start

You need Node.js 22 or newer and an API key for at least one model provider.

```bash
npm install -g hob-bot
HOB_PASSWORD='choose-a-password' hob
```

Or run it once without installing: `HOB_PASSWORD='choose-a-password' npx hob-bot`.

With Docker instead (no Node.js needed; details in [Docker](#docker)):

```bash
curl -O https://raw.githubusercontent.com/FFatTiger/hob/main/compose.yaml
echo "HOB_PASSWORD=choose-a-password" > .env
docker compose up -d
```

Open <http://127.0.0.1:30148> and sign in with that password. Then:

1. Go to **设置 → 服务商** (Settings → Providers) and add a provider. Built-in ones (Anthropic, OpenAI, Google, DeepSeek, OpenRouter, …) only need an API key; any OpenAI- or Anthropic-compatible endpoint works too.
2. Go to **设置 → 模型** (Settings → Models) and pick the models for chat and for jobs.
3. Send Hob a message. A reply, or a job card for real work, means you are set.

The password is hashed into `~/.hob/system/config.json` on first start, so later starts don't need `HOB_PASSWORD`. You can change it under **设置 → 通用**.

## Configuration

Startup options are environment variables. Everything else, including providers, models, memory, search, skills and notifications, lives in the settings UI and takes effect immediately.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOB_HOME` | `~/.hob` | Data directory |
| `HOB_PORT` | `30148` | HTTP port |
| `HOB_HOST` | `127.0.0.1` | Listen address |
| `HOB_PASSWORD` | — | Sign-in password; required on first start unless `password` is set in `config.json` |
| `HOB_DESKTOP_URL` | — | Cloud desktop service URL for deployment configuration |
| `HOB_DESKTOP_TOKEN` / `HOB_DESKTOP_TOKEN_FILE` | — | Cloud desktop bearer token or path to its token file; with a URL, a nonempty token overrides the UI setting |
| `HOB_LOCAL_PI_DIR` / `HOB_LOCAL_LORE_HOME` | `~/.pi/agent` / `~/.lore` | Optional source directories for explicit local imports; original `PI_CODING_AGENT_DIR` / `LORE_HOME` are used when these are unset |

`config.json` can also set `host`, `port` and the initial `password`; environment variables take precedence for host and port. Hob isolates its engine and memory directories under `HOB_HOME` and removes inherited model and Lore credentials from its runtime environment.

Conversations, jobs, memory, skills, keys and engine state live in `HOB_HOME`, grouped by ownership: `system/` (config, keys, engine, Lore, memory), `cache/` (regenerable), `assistants/<id>/` (each assistant's profile, conversation, routines, jobs and files) and `archive/`. To reuse providers or a Lore connection you already have on the machine, import them explicitly in settings. Back up `HOB_HOME` to preserve Hob's data.

**Data layout migration.** Older versions kept everything flat in `HOB_HOME` (`jobs/`, `pages/`, `images/` … plus a few JSON files at the root). On start Hob migrates that layout automatically, before touching the engine: it checks free space, takes a full verified copy in `HOB_HOME/backup-v1-<time>/` (permissions and symlinks preserved), moves files, and only then writes `system/moves.json` (old path → new path) and `layout.json`. If the process dies mid-way, the next start restores from the backup and runs again. Backups are never deleted automatically — remove `backup-v1-*` yourself once you are happy with the new layout (it contains a copy of your keys). Two commands help:

```
npm run layout -- --dry-run   # print the migration plan, change nothing
npm run layout -- --restore   # go back to the old layout from the backup
# installed from npm: hob layout --dry-run / hob layout --restore
# Docker (stop Hob first): docker compose run --rm hob node bin/hob.mjs layout --restore
```

Downgrading means restoring the old layout first: older versions do not understand the new one and must not write the same data directory.

**Claude subscription:** For npm or source installs, install Claude Code and sign in locally with `claude auth login`, then enable Claude subscription under **Settings → Providers**, choose Pro or Max and select the models under **Settings → Models**. Usage counts against the same Claude subscription quota as Claude Code. Docker images do not support this feature. Hob does not read, copy, store or forward Claude credentials; the official Claude Code program uses its existing login. Claude Code writes its own session records under `~/.claude/projects/`, outside `HOB_HOME`.

## Deploy

Hob is a single Node process. Run it with any process manager and put a reverse proxy with TLS in front. Push notifications and installing as an app both need HTTPS. With PM2:

```bash
pm2 start hob --name hob           # after npm install -g hob-bot
pm2 start deploy/pm2.config.cjs   # or from a source checkout: process "hob", port 30148, data in ~/.hob
```

### Docker

```bash
curl -O https://raw.githubusercontent.com/FFatTiger/hob/main/compose.yaml
echo "HOB_PASSWORD=change-me" > .env   # only needed on first start
docker compose up -d
```

This pulls `ghcr.io/ffattiger/hob` (amd64 and arm64, built for every release). From a source checkout, `docker compose up -d --build` builds the image locally instead. Open `http://127.0.0.1:30148`. Data lives in the `hob-data` volume (`/data` in the container), and the password is stored there as a hash, so you can delete `.env` afterwards. The port is bound to localhost for a reverse proxy; change it to `"30148:30148"` in `compose.yaml` for direct LAN access.

Jobs run inside the container (git, curl, python3, ripgrep and fd are installed). Local-command MCP servers also run inside the container, so their command must exist in the image (node and npx are included; uvx and other language package managers are not). To let jobs work on projects on the host, create `workspace/` (the container runs as uid 1000), uncomment the `./workspace:/workspace` mount and give jobs that directory.

### Cloud desktop

The optional cloud desktop is a separate Linux container. Each assistant has its own screen and browser profile, started on first use. Assistants can operate their browser directly and share its login state with their jobs; when a job is using the browser, the assistant is asked to wait or coordinate with it. Browser and desktop screenshots can be sent in chat. An additional public screen can be enabled for selected assistants in Settings → Cloud desktop; by default no assistant can use it. Only one job uses the public screen at a time, and others wait up to 10 minutes. Screens with no viewers, browser connections or activity are reclaimed after 30 minutes by default; browser login data persists. With the root `compose.yaml` and `HOB_PASSWORD` set in `.env`, start both services with:

```bash
docker compose --profile desktop up -d
```

The desktop is not published to the host network. Hob reads the generated token from a shared volume and shows **由部署配置** in Settings → Cloud desktop. Without the profile Hob runs alone and the desktop is unconfigured.

For an independent deployment, use [`desktop/compose.yaml`](desktop/compose.yaml) or the `docker run` command in [the desktop guide](desktop/README.md), then enter the service URL and token in Hob's settings. When the desktop profile is not running and its shared token file is absent or empty, Hob uses the desktop configured in settings; once the token file appears, the Compose deployment takes precedence. Anyone signed into Hob can view and take over an individual screen; log into websites yourself, not through the assistant. Google currently blocks Google account sign-in in a browser with remote debugging enabled. Browser cookies in the desktop data volume are sensitive. Bearer tokens travel in cleartext over HTTP: use a trusted private network or HTTPS for connections between machines, and do not expose VNC or CDP ports.

`TZ` (IANA zone) and `DESKTOP_LANG` (BCP 47 tag, e.g. `en-US`) set the desktop container's timezone and language; both go in the `.env` file next to `compose.yaml` and default to `UTC` and `zh-CN`. They drive the UI language of every program on the desktop, the browser UI language, and the `Accept-Language` / `navigator.languages` the browser sends to websites; `DESKTOP_RESOLUTION` (default `1280x800`) sets the screen size. Sites compare the IP's location with timezone, language and screen, so change them together when the egress network is not in mainland China. Existing browser profiles follow the deployment setting, so a language chosen in browser settings is overridden.

Measured for desktop v2 on an amd64 host: image disk usage was 2.03 GB; memory was 23.5 MiB without screens, 354.9 MiB with one Chrome screen on example.com, and 1017 MiB with three Chrome screens on new tabs. The page workloads differ, and actual usage depends on the host and pages.

Behind a reverse proxy, the desktop view needs WebSocket upgrades on `/api/desktop/vnc`. With nginx:

```nginx
location = /api/desktop/vnc {
    proxy_pass http://127.0.0.1:30148;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
}
```

The bundled noVNC client is licensed under MPL-2.0; Playwright is Apache-2.0.

## Development

```bash
git clone https://github.com/FFatTiger/hob.git
cd hob
npm install
npm run build
npm start            # same as the `hob` command, from source
npm run dev:server   # API server with reload, port 30148
npm run dev:web      # Vite dev server; proxies /api to 30148
npm test             # vitest
npm run typecheck
```

Add `?mock=1` to the dev URL to run the UI against an in-browser fake backend. No model or server is needed, and the screenshots above were taken that way.

Stack: Node 22 + TypeScript, Hono with SSE, Vite + React with hand-written CSS. The agent engine is the [pi](https://github.com/earendil-works/pi) SDK, used in-process. Read [docs/architecture.md](docs/architecture.md) for the design, data layout and tool list (in Chinese).

## License

[MIT](LICENSE)

## Community

This open-source project is linked with and endorses the [LINUX DO community](https://linux.do).
