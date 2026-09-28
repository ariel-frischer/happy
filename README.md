<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/.github/logotype-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="/.github/logotype-light.png">
    <img src="/.github/logotype-dark.png" width="400" alt="Happy">
  </picture>
</div>

<h1 align="center">
  Mobile and Web Client for Claude Code & Codex
</h1>

<h4 align="center">
Use Claude Code or Codex from anywhere with end-to-end encryption.
</h4>

<div align="center">
  
[🖥️ **macOS App**](https://github.com/slopus/happy-desktop/releases/latest) • [📱 **iOS App**](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) • [🤖 **Android App**](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) • [🌐 **Web App**](https://app.happy.engineering) • [🎥 **See a Demo**](https://youtu.be/GCS0OG9QMSE) • [📚 **Documentation**](https://happy.engineering/docs/) • [💬 **Discord**](https://discord.gg/fX9WBAhyfD)

</div>

## Happy + omp (personal fork, experimental)

This is Ariel's personal, experimental fork of [slopus/happy](https://github.com/slopus/happy). It adds support for [omp (Oh My Pi)](https://github.com/can1357/oh-my-pi). It is not affiliated with or supported by the Happy maintainers, and it may break at any time. Everything below this section is upstream's README.

**What works**

- `happy acp omp` runs omp headless over ACP. Approvals and `ask` forms work on the phone in this mode.
- omp is the first agent in the app and the default for new sessions. The daemon can start it on your computer.
- Live TUI mirror: with the `happy-bridge` omp extension, a normal `omp` TUI on your laptop mirrors itself into Happy. It stays the only omp process. Phone messages go into that same session. If a turn is running, they steer it.
- Sessions started from the phone run the omp TUI in a detached tmux session. Attach with `tmux attach -t happy-omp-<id>`. Without tmux, the daemon falls back to `happy acp omp`.
- `ask` questions show inline in the chat and in the TUI at the same time. The first answer wins. After you submit, the card keeps the full questions and answers.
- Tool calls show as compact cards. Tap a card to see its output. Stop in the app aborts the running turn; background jobs keep running.
- Subagent runs show live progress on the task card (`2 subagents · 1 running · 1 done`). The card keeps counting after the task call returns with subagents still in the background.
- Background jobs (async bash, background subagents) show in a strip above the input while they run. Each row has its own Stop; tap a row to open the card that started it. Each finished job adds a card with its output (`Subagent done · 1m 12s`).
- `/compact`, `/model` and `/thinking` typed in the app run in the mirrored session. Other omp commands (`/new`, `/resume`, `/fork`, and so on) only run from the TUI: the app shows a note and nothing reaches the model. Unknown `/text` goes to the model as a normal message.
- `/resume` in the TUI reattaches the omp session to the Happy session it was mirrored to before. A session that was never mirrored gets a new Happy session with its recent history backfilled.
- Images from tool results show inline, and a tap opens them fullscreen. Images you attach in the app reach omp.
- Deleting or stopping a mirrored session in the app detaches the mirror. The TUI keeps running.
- Opt out per run with `OMP_HAPPY_BRIDGE=0 omp`.

**Known limits**

- Tool approvals in a mirrored TUI stay on the laptop (or omp Collab). omp lets extensions observe approval requests but not answer them.
- Happy's own push notifications need your own FCM credentials in the app build. Use ntfy (or similar) for pushes until then.
- Tapping a background job opens its card's detail view; the chat does not scroll to the card.
- Racing `ask` between the TUI and the app depends on omp internals. It was built against omp 18.3.5; later omp versions may break it.

**Setup**

1. Build and link the CLI from this repo: `pnpm install && pnpm --filter happy build`, then `npm link` in `packages/happy-cli`.
2. Put the `happy-bridge.ts` omp extension in `~/.omp/agent/extensions/`. It lives in Ariel's omp config, not in this repo.
3. Authenticate and start the daemon: `happy auth login`, then `happy daemon start` (after a rebuild: `happy daemon stop; happy daemon start`).
4. Run `omp` as usual. The session appears in the app.

<img width="5178" height="2364" alt="github" src="/.github/header.png" />


<h3 align="center">
Step 1: Download App
</h3>

<div align="center">
<a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>
</div>

<h3 align="center">
Step 2: Install CLI on your computer
</h3>

```bash
npm install -g happy
```

> Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

<h3 align="center">
Step 3: Start using `happy` instead of `claude` or `codex`
</h3>

```bash
# Instead of claude, use:
happy claude
# or
happy codex
```

<h3 align="center">
Step 4 (optional): Get the desktop app
</h3>

<div align="center">
  <a href="https://github.com/slopus/happy-desktop/releases/latest">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="/.github/banner-desktop-dark.png">
      <source media="(prefers-color-scheme: light)" srcset="/.github/banner-desktop-light.png">
      <img src="/.github/banner-desktop-dark.png" width="640" alt="Now on Mac desktop — download for macOS">
    </picture>
  </a>
</div>

<p align="center">
Prefer a native app over the terminal? <a href="https://github.com/slopus/happy-desktop/releases/latest"><b>Download Happy for macOS</b></a> — conversations beside the files, diffs, terminals, and previews your work actually touches.
</p>

## How does it work?

On your computer, run `happy` instead of `claude` or `happy codex` instead of `codex` to start your AI through our wrapper. When you want to control your coding agent from your phone, it restarts the session in remote mode. To switch back to your computer, just press any key on your keyboard.

## 🔥 Why Happy Coder?

- 📱 **Mobile access to Claude Code and Codex** - Check what your AI is building while away from your desk
- 🔔 **Push notifications** - Get alerted when Claude Code and Codex needs permission or encounters errors  
- ⚡ **Switch devices instantly** - Take control from phone or desktop with one keypress
- 🔐 **End-to-end encrypted** - Your code never leaves your devices unencrypted
- 🛠️ **Open source** - Audit the code yourself. No telemetry, no tracking

## 📦 Project Components

- **[Happy Desktop](https://github.com/slopus/happy-desktop)** - Native macOS app ([download](https://github.com/slopus/happy-desktop/releases/latest))
- **[Happy App](https://github.com/slopus/happy/tree/main/packages/happy-app)** - Web UI + mobile client (Expo)
- **[Happy CLI](https://github.com/slopus/happy/tree/main/packages/happy-cli)** - Command-line interface for Claude Code and Codex
- **[Happy Agent](https://github.com/slopus/happy/tree/main/packages/happy-agent)** - Remote agent control CLI (create, send, monitor sessions)
- **[Happy Server](https://github.com/slopus/happy/tree/main/packages/happy-server)** - Backend server for encrypted sync

## 🏠 Who We Are

We're engineers scattered across Bay Area coffee shops and hacker houses, constantly checking how our AI coding agents are progressing on our pet projects during lunch breaks. Happy Coder was born from the frustration of not being able to peek at our AI coding tools building our side hustles while we're away from our keyboards. We believe the best tools come from scratching your own itch and sharing with the community.

## 📚 Documentation & Contributing

- **[Documentation Website](https://happy.engineering/docs/)** - Learn how to use Happy Coder effectively
- **[Contributing Guide](docs/CONTRIBUTING.md)** - How to contribute, PR guidelines, and development setup
- **[Edit docs at github.com/slopus/slopus.github.io](https://github.com/slopus/slopus.github.io)** - Help improve our documentation and guides

## License

MIT License - see [LICENSE](LICENSE) for details.
