# Codex Deck

**English** · [简体中文](README.zh-CN.md)

> Recreate the core of OpenAI's **Codex Micro** — the agent-control keyboard for Codex — on an off-the-shelf **15-key Stream Deck** (5×3): live agent status, approve/reject, send, new chat, reasoning level, push-to-talk and profile switching.

<div align="center">

![License](https://img.shields.io/badge/license-MIT%2BCommons%20Clause-blue)
![Platform](https://img.shields.io/badge/platform-macOS-lightgrey)
![Device](https://img.shields.io/badge/Stream%20Deck-15%20keys-000000)
![Status](https://img.shields.io/badge/status-active-success)

</div>

## Table of contents

- [Quick start](#quick-start)
- [What is this?](#what-is-this)
- [Key layout (bundled profile)](#key-layout-bundled-profile)
- [Key descriptions](#key-descriptions)
- [Features](#features)
- [Icons](#icons)
- [Requirements](#requirements)
- [Installation](#installation)
- [Status colors](#status-colors)
- [License](#license)
- [Credits](#credits)

## Quick start

1. Install the prebuilt plugin (zero-install) or build from source — see [Installation](#installation).
2. Keep the Codex desktop app running and logged in.
3. Match the keyboard shortcuts in the desktop app (Settings → Keyboard shortcuts): ⌘⌥A approve, ⌘⌥R decline, ⌘⌥S send, ⌘⌥E cycle reasoning effort. (Or rebind them to your own shortcuts.)
4. Done — the five session keys show your latest threads with live status; the command keys handle approve / reject / send / new chat; PTT triggers your own push-to-talk service.

## What is this?

Codex Micro is OpenAI's first piece of hardware for Codex agent workflows: a row of live-status agent keys, plus command keys for approving, rejecting and sending, and a push-to-talk control.
This project rebuilds that core experience on a regular Stream Deck, based entirely on Codex's **official local control channel** — no GUI automation, no reverse engineering, no cloud dependencies.

![Preview](assets/preview/session-preview.gif)

![Hardware preview](assets/preview/Hardware-preview.jpg)

The result: five agent keys show your most recent Codex threads (active ones first) with live status — thinking… / unread / waiting for approval / error / idle / offline; a row of command keys approves or declines permission requests, sends, starts a new chat and cycles the reasoning level. The plugin renders the key faces itself, with breathing/flashing animations close to the real device.

> ⚠️ This is an independent, unofficial re-implementation of a hardware product. It is not affiliated with OpenAI or Work Louder.

## Key layout (bundled profile)

Profile Page 1:

| ① | ② | ③ | ④ | ⑤ |
| --- | --- | --- | --- | --- |
|  Session 1 |  Session 2 |  Session 3 |  Session 4 |  Session 5 |
| Accept | Reject | ChatGPT | New Chat | Reasoning |
| PTT | Send | Profile | Previous Session | Next Session |

| Row | Action |
| --- | --- |
| 1 — session keys | live session keys (plugin) |
| 2 — command keys | ⌘⌥A / ⌘⌥R / open ChatGPT app / ⌘N / ⌘⌥E |
| 3 — control keys | ⌥Space / ⌘⌥S / next profile / ⇧⌘[ / ⇧⌘] |

## Key descriptions

- **Session keys (row 1)** — show your five most recent Codex threads with live status (thinking… / unread / waiting for approval / error / idle / offline). Press one to jump to that thread in the desktop app and make it the target of the command keys.
- **Reasoning** — plugin + shortcut driven: a single press cycles the reasoning effort and shows the current level (e.g. High).
- **ChatGPT key** — opens the desktop app; long-press quits it.
- **Other command keys** — trigger the native keyboard shortcuts (Accept / Reject / Send / New Chat).
- **PTT** — sends the configured shortcut (default: left ⌥ + Space) to your own third-party push-to-talk service (e.g. WeChat voice input).
- **Previous Session / Next Session** — switch between chats in the desktop app.

> Hotkeys set in this profile differ from ChatGPT app’s default shortcuts. To use the plugin’s bundled profile, adjust the default action hotkeys following the layout diagram.
(Or modify the profile directly within the official Stream Deck app to align with your existing hotkeys.)

## Features

| Codex Micro feature | Implementation |
| --- | --- |
| Agent keys with live status | 5 keys poll `thread/list`; the key face reflects status (thinking… / unread / waiting for approval / error / idle / offline); pressing one selects it as the command-key target and jumps to it in the desktop app (`codex://threads/<id>`) |
| Accept / Reject | Triggers approve / decline via simulated shortcuts |
| Send | Sends the text in the input box via a simulated shortcut |
| New Chat | Creates a new chat via a simulated shortcut |
| Reasoning cycling | The plugin reads the desktop app's persisted `reasoning_effort` (`~/.codex/state_5.sqlite`) and cycles it through the app's own shortcut |
| Push-to-talk | PTT key as trigger — which PTT service and shortcut to use are up to you |
| Chat switching | Switches chats via simulated shortcuts matching the desktop app |
| Profile switching | Stream Deck built-in action, cycles between profiles |

## Icons

All key glyphs come from the **Fluent UI System Icons** Stream Deck icon pack by Carlo Zottmann, built from Microsoft's Fluent UI System Icons:

- Pack repository: <https://github.com/czottmann/streamdeck-iconpack-fluentui-system-icons>
- Upstream icon set: <https://github.com/microsoft/fluentui-system-icons>
- License: MIT (pack) / MIT (Microsoft Fluent UI System Icons)

## Requirements

- Stream Deck software **7.1+** (SDK v3) and a **15-key Stream Deck** (MK.2 / Classic); other Stream Deck models may work too — contributions welcome
- A logged-in **ChatGPT desktop app** — the plugin starts the app-server automatically with its bundled `codex` binary; **no separate CLI install needed**
- Currently only tested on **macOS 26.6 (25G72)**
- Permissions on first use: System Events (reasoning cycling / AppleScript PTT fallback) and Input Monitoring (PTT helper)
- Only when building from source: **Node.js 24+** and **clang** (macOS dev tools). The PTT helper ships prebuilt for Apple Silicon (arm64); Intel Macs compile it themselves

## Installation

### 1. Zero-install for users (recommended)

With only the two official apps installed — the Stream Deck software and the ChatGPT/Codex desktop app — **no Node.js, npm, clang, standalone Codex CLI or terminal is required**:

1. Double-click the prebuilt `com.codexdeck.streamDeckPlugin` (or drag the `com.codexdeck.sdPlugin` folder into the Stream Deck app window).
2. Stream Deck installs the plugin; the "Codex Micro" profile auto-installs with it (`AutoInstall: true`).
3. On first use, grant the requested permissions: System Events (reasoning cycling / AppleScript PTT fallback) and Input Monitoring (PTT helper).
4. Keep the ChatGPT / Codex desktop app running and logged in — the plugin connects to the app-server automatically.

The desktop app bundles the `codex` binary (`Contents/Resources/codex`): when the control socket (`~/.codex/app-server-control/app-server-control.sock`) is missing, the plugin starts the daemon with that binary itself.

### 2. Build from source (developers)

```bash
npm install
npm run icons       # generate key/icon PNGs into the plugin bundle
npm run dist        # bundle bin/plugin.js + generate the profile
clang -O2 -framework CoreGraphics -framework CoreFoundation \
  -o com.codexdeck.sdPlugin/bin/ptt-helper tools/ptt-helper.c   # macOS PTT helper
npx streamdeck link .
```

`npm run dist` is `build + profile`; icons are a separate step (`npm run icons`), so run it first — the profile generator reads the generated PNGs. The bundled profile auto-installs with the plugin (`AutoInstall: true`). To produce a distributable package for the zero-install flow, run `npx streamdeck pack`.

**Language variants.** Two distributable packages ship in the repo root: `com.codexdeck.streamDeckPlugin` (Chinese key faces — 最新对话 / 思考中… / 未读 / 等待确认 / …) and `com.codexdeck-en.streamDeckPlugin` (English — "Session N" / "Thinking…" / "Unread" / "Waiting" / …). Rebuild a variant with `CODEXDECK_LANG=zh|en npm run dist`, then pack it (`npx streamdeck pack`).

### 3. Manual profile import

Import [profiles/Codex Micro.streamDeckProfile](profiles/Codex%20Micro.streamDeckProfile) in the Stream Deck software, then drag actions from the "Codex Deck" category onto keys if the layout does not apply to your device.

### 4. First run: app-server daemon (usually nothing to do)

With the normal desktop-app setup the plugin handles this automatically (see step 1). This step is only for setups without the ChatGPT desktop app, e.g. CLI-only environments: `codex app-server daemon start` requires a Codex CLI on `PATH` or at `~/.codex/packages/standalone/current/codex`. The official installer is at `https://chatgpt.com/codex/install.sh`. If the ChatGPT desktop app is installed, symlink its bundled binary:

```bash
node scripts/setup-daemon.mjs
```

The daemon and the desktop app share the `~/.codex/sessions` store: conversations started from the daemon appear in the desktop app and vice versa. Stop the daemon with `codex app-server daemon stop`.

> Note: the standalone daemon and the desktop app are separate processes. The daemon can list/read all sessions (including ones the desktop app is using), but it does not see the desktop app's in-memory real-time state (thinking…).

## Status colors

All breathing states share the same 2.4 s cycle (dim → bright → dim). Each breathing state has a bright base color and a dark flash color:

| Status | Base (bright) | Flash (dark) | Notes |
| --- | --- | --- | --- |
| Thinking… | #94C8F8 (148,200,248) | #4A7DA8 | background breathe + dark-blue ring pulse |
| Unread | #A4E898 (164,232,152) | #7FBF74 | reads the desktop app's real unread state; breathing |
| Waiting for approval | #F6D2BC (246,210,188) | #D99B74 | breathing |
| Error | #E86860 (232,104,96) | #B04038 | breathing |
| Idle | #E4E4E4 (228,228,228) | — | static |
| Offline | #C9C9C9 | — | static |

- The thinking animation is inspired by the Cortana animation on Windows Phone.
- The unread state reads the desktop app's own persisted data (`~/.codex/.codex-global-state.json` → `electron-persisted-atom-state.unread-thread-ids-by-host-v1`) — the same source as the official UI's unread badge; it clears once the chat is opened.

## License

**MIT + Commons Clause — non-commercial, source-available.**

- The code is licensed under the [MIT License](LICENSE): use, modify and share freely for personal, educational and non-commercial purposes, with attribution.
- The [Commons Clause License Condition](COMMONS-CLAUSE.md) adds a single condition — **commercial use of the Software is not permitted** (no selling, no paid hosting, consulting or support built on it).

## Credits

- Protocol integration is based on the openai/codex [app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) and the Codex CLI's local control channel.
- Key glyphs are based on Microsoft [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons) (MIT), composited from [czottmann/streamdeck-iconpack-fluentui-system-icons](https://github.com/czottmann/streamdeck-iconpack-fluentui-system-icons).
