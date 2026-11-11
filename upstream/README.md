<div align="center">

<img src="web/public/icons/icon-192.png" width="88" alt="Hob's pixel flame icon">

# Hob

A self-hosted personal assistant. Tell it what you need: it handles small things on the spot,<br>
hands longer work to background jobs, and checks with you when your rules say a decision is yours.

[![npm version](https://img.shields.io/npm/v/hob-bot?color=e8590c)](https://www.npmjs.com/package/hob-bot)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io%2Fffattiger%2Fhob-2496ed)](https://github.com/FFatTiger/hob/pkgs/container/hob)
![Requires Node.js 22 or newer](https://img.shields.io/badge/node-%E2%89%A5%2022-339933)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[中文说明](README.zh-CN.md) · [Quick start](#quick-start) · [Deploy](#deploy) · [Architecture](docs/architecture.md)

</div>

> The interface is currently Chinese-only. Hob is a single-user app that runs on your own machine or server with your own model API keys.

![Chatting with the main assistant: job cards and delegation cards, with a job's live transcript in the side panel](docs/screenshots/assistant.png)

## How it works

- **You talk to assistants.** Each assistant has its own duties, rules, skills and schedules. It handles small requests itself and hands longer work to background jobs. A job card shows the live transcript, lets you add instructions or stop the job, and the result comes back into the conversation.
- **Your rules decide what needs your approval.** Global rules and each assistant's own rules say which actions wait for your confirmation and which go ahead. When you confirm something, you can save it as a rule so the same kind of request isn't asked again.
- **Work goes to the right assistant.** The main assistant, Hob, delegates requests that belong to another assistant and tracks them with a delegation card. When similar requests keep coming up, it offers to create a dedicated assistant for them.
- **Schedules wake an assistant only when something changed.** A schedule can carry a check script that runs first; the assistant takes over only when the script finds something new.
- **Finished work becomes a skill.** When a job's approach is worth keeping, the assistant can have the job write it up as a skill that later jobs receive. Every change is kept as a new version.

## A team of assistants

Put several assistants in a group and they work as a team: the group owner takes messages that don't name anyone, `@` calls a specific member, and each member can use different models in that group. The owner handles the group's schedules and decides what to do when one fires.

In a group that uses the software-development workflow, a larger request becomes a topic with a project: clarify the request, split it into subtasks for the members, run them in the project's working directory, and check each acceptance criterion at the end. New installations come with an agile team group with product, architecture, development, testing and release members.

![A group topic: the project's stages, its subtasks and the members' job cards](docs/screenshots/chat.png)

## On a phone

Hob works in a mobile browser and can be added to the home screen as an app. Push notifications tell you when an assistant needs your decision or a job gets stuck or fails (HTTPS required).

![Hob on a phone: the home list, a job card in a conversation and a project view](docs/screenshots/mobile.png)

## Also included

- **Models**: built-in providers such as Anthropic, OpenAI, Google, DeepSeek and OpenRouter only need an API key; any OpenAI- or Anthropic-compatible endpoint works too. npm and source installs can also use your local Claude Code subscription.
- **Knowledge bases**: organize and preview files, bind them to assistants and follow citations back to the source; with an embedding model you get hybrid search, including PDF text.
- **Web search**: SearXNG, Exa, Tavily, Brave, Serper, Jina, Firecrawl, Perplexity, You.com and Ollama.
- **MCP**: jobs can call the MCP services you configure, including configurations imported from Claude Code, Cursor and pi.
- **Memory**: stored locally or in [Lore](https://github.com/FFatTiger/lore).
- **Pages and images**: assistants can present comparisons and research as pages in the side panel, and generate or edit images through an OpenAI-compatible image API.
- **Cloud desktop** (optional): a browser for each assistant, sharing its login state with that assistant's jobs; you can watch or take over.
- **Usage**: requests, tokens and estimated cost by model and by assistant.

## Quick start

You need Node.js 22 or newer and an API key for at least one model provider.

```bash
npm install -g hob-bot
HOB_PASSWORD='choose-a-password' hob
```

To try it without installing, run `HOB_PASSWORD='choose-a-password' npx hob-bot`. With Docker instead (no Node.js needed):

```bash
curl -O https://raw.githubusercontent.com/FFatTiger/hob/main/compose.yaml
echo "HOB_PASSWORD=choose-a-password" > .env
docker compose up -d
```

Open <http://127.0.0.1:30148>, sign in with that password, then:

1. **设置 → 服务商** (Settings → Providers): add a provider and its API key.
2. **设置 → 模型** (Settings → Models): pick the models for chat and for jobs.
3. Send Hob a message. A reply, or a job card for real work, means you are set.

The password is only needed on the first start; it is stored as a hash in the data directory. Change it under **设置 → 通用** (Settings → General).

## Deploy

Hob is a single Node process, and all of its data lives in `HOB_HOME` (`~/.hob` by default).

- **Keep it running** with any process manager, for example `pm2 start hob --name hob` (from a source checkout: `npm run build`, then `pm2 start deploy/pm2.config.cjs`). Put a reverse proxy with TLS in front; push notifications and adding to the home screen both need HTTPS.
- **Docker**: the image is `ghcr.io/ffattiger/hob` (amd64 and arm64) and data lives in the `hob-data` volume; in a source checkout, add `--build` to build the image locally. The port is bound to localhost; for direct LAN access change it to `"30148:30148"` in `compose.yaml`. Jobs and local-command MCP servers run inside the container, which includes git, curl, python3, ripgrep, fd, node and npx. To let jobs work on projects on the host, create `workspace/` (the container runs as uid 1000) and uncomment the `./workspace:/workspace` mount.
- **Cloud desktop**: `docker compose --profile desktop up -d` starts Hob and the desktop together with the token already wired up. For a separate deployment, reverse-proxy settings and resource usage, see the [desktop guide](desktop/README.md).
- **Claude subscription**: for npm or source installs, install Claude Code, run `claude auth login`, then enable Claude subscription under **设置 → 服务商**. Usage counts against your subscription quota; Hob does not read or store Claude credentials, and Claude Code keeps its own session records in `~/.claude/projects/`. Docker images don't support this.
- **Backups and upgrades**: back up `HOB_HOME` to keep everything. Upgrading from a version before 1.5 migrates the data directory automatically and keeps a full backup; see the [1.5.0 release notes](https://github.com/FFatTiger/hob/releases/tag/v1.5.0) for details and rollback. With Docker, roll back with `docker compose run --rm hob node bin/hob.mjs layout --restore` after stopping Hob.

## Configuration

Startup options are environment variables (`host`, `port` and an initial `password` can also go in `HOB_HOME/system/config.json`; for host and port the environment variables win). Everything else is set in the UI and takes effect immediately.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOB_HOME` | `~/.hob` | Data directory |
| `HOB_PORT` | `30148` | HTTP port |
| `HOB_HOST` | `127.0.0.1` | Listen address |
| `HOB_PASSWORD` | — | Sign-in password, needed only on the first start |
| `HOB_DESKTOP_URL`, `HOB_DESKTOP_TOKEN` or `HOB_DESKTOP_TOKEN_FILE` | — | Cloud desktop set by the deployment; with both a URL and a token it overrides the UI setting |
| `HOB_LOCAL_PI_DIR`, `HOB_LOCAL_LORE_HOME` | `~/.pi/agent`, `~/.lore` | Directories read when you import from this machine in settings |

`HOB_HOME` is grouped by ownership: `system/` (config, keys, engine, memory), `assistants/<id>/` (each assistant's conversation, schedules, jobs and files), `cache/` (regenerable) and `archive/`. Hob uses only this directory: existing pi or Lore configuration on the machine is never read automatically, only when you import it in settings.

## Development

```bash
git clone https://github.com/FFatTiger/hob.git
cd hob
npm install
npm run build && npm start   # run from source, same as the hob command
npm run dev:server   # API server with reload, port 30148
npm run dev:web      # Vite dev server; proxies /api to 30148
npm test
npm run typecheck
```

Add `?mock=1` to the dev URL to run the UI against an in-browser fake backend, with no model or server needed. The screenshots in this README are taken that way by `scripts/readme-screenshots.mjs`.

Stack: Node 22 + TypeScript, Hono with SSE, Vite + React with hand-written CSS. The agent engine is the [pi](https://github.com/earendil-works/pi) SDK, running in-process. See [docs/architecture.md](docs/architecture.md) for the design, data layout and tool list (in Chinese).

## License

[MIT](LICENSE). The bundled noVNC client is licensed under MPL-2.0 and Playwright under Apache-2.0.

This open-source project is linked with and endorses the [LINUX DO community](https://linux.do).
