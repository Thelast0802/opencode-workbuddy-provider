# WorkBuddy Provider for OpenCode 🌐

[![GitHub Release](https://img.shields.io/github/v/release/Thelast0802/opencode-workbuddy-provider?color=blue)](https://github.com/Thelast0802/opencode-workbuddy-provider/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenCode Provider](https://img.shields.io/badge/OpenCode-Provider-007acc.svg)](https://opencode.ai)
[![OpenChamber Compatible](https://img.shields.io/badge/OpenChamber-Compatible-2ea44f.svg)](https://github.com/openchamber)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933.svg)](https://nodejs.org/)

[English](#english) | [中文说明](#中文说明)

---

<a name="english"></a>
## English

An open-source, high-performance model provider & gateway adapter for **[OpenCode](https://opencode.ai)** with native graphical panel integration for **[OpenChamber](https://github.com/openchamber)**.

It seamlessly bridges Tencent WorkBuddy & CodeBuddy upstream services into the OpenCode ecosystem, granting instant access to GPT-6, Claude-3.5-Sonnet, Gemini-3.5, and DeepSeek-V4.1-Flash. Built with upstream 5.8.4 client signature alignment to eliminate channel verification errors (`code 11128`), native reasoning trace support for DeepSeek thinking, latency probes, and local token telemetry.

### 🌟 Why This Project Matters

Modern autonomous AI coding agents (such as OpenCode) rely heavily on reliable, multi-model execution environments. However, developers frequently encounter:
1. **WAF & Channel Verification Blocks**: Upstream gateway rejections (`11128: request illegal`) due to missing desktop client tracking headers.
2. **Lost Reasoning Traces**: Reasoning models (like DeepSeek V4.1 Flash) disabling thinking output unless explicit effort levels and thinking parameters are collaboratively negotiated.
3. **GUI & CLI Disconnect**: Fragmented configurations between pure terminal agents (OpenCode) and desktop environments (OpenChamber).

`opencode-workbuddy-provider` solves these bottlenecks with an intelligent local proxy daemon and dynamic manifest synchronization.

### 🚀 Key Features

- 🎯 **OpenCode First**: Automatically updates `~/.config/opencode/opencode.json` with zero manual configuration. Operates natively with the `opencode` terminal CLI.
- 👥 **Multi-Account Pool & Hot-Swapping (v1.1.0)**: Manages multiple International and China accounts simultaneously. Switch active accounts instantly via GUI dropdown or CLI (`--switch <id>`) with zero downtime. Automatically detects and flags upstream 11140 account restrictions.
- 🛡️ **Hardened Protocol & Anti-Ban Safeguards (New in v1.2.0)**: Integrated upstream hardening patches to protect user accounts from restrictions:
  - **Dynamic Version Sync**: Automatically sniffs local desktop WorkBuddy and `@genie/agent-cli` installations (supporting macOS, Windows, Linux) to mirror runtime signatures (`X-IDE-Type: CLI`), eliminating fingerprint discrepancies from outdated static UAs.
  - **Identity Sanitizer & Zero-Width Spacing**: Neutralizes unapproved agent system prompt openings (`You are OpenCode...` / `You are Claude Code...`) and injects invisible `\u200B` zero-width spaces into agent identity clauses, bypassing strict upstream WAF pattern matching.
  - **Account Quarantine Circuit Breaker**: Strictly isolates restricted accounts upon receiving `11140: unusual activity` error and halts automatic retries on the account pool, preventing cascading chain-bans across alt accounts.
  - **6004 Model Detour**: Handles per-model rate limits (`6004`) by smoothly detouring to alternative high-tier candidate models (`hy4-preview`, `glm-5.3`, `kimi-k2.8-preview`) on the *same account*, preventing unnecessary alt-account burns.
- 🖥️ **OpenChamber GUI Companion**: Provides a sidebar Webview extension with protocol hardening status badge, visual control, model speed testing, live balance calibration, and toggling.
- 🛡️ **5.8.4 Client Signature Alignment**: Full out-of-the-box emulation of official desktop headers (`X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`, `X-Root-Request-ID`, W3C traceparents) to permanently resolve upstream `11128` channel verification rejections.
- 🧠 **Native DeepSeek Thinking (Reasoning)**: Declares `capabilities.reasoning` in OpenCode, displaying real-time thinking collapsible blocks in both CLI and GUI interfaces.
- 🌐 **Dual-Region Support**: Instant switching between International (`workbuddy.ai`) and China (`copilot.tencent.com`).
- ⚡ **Stream Speed Probes**: Sub-second, low-overhead time-to-first-token (TTFT) latency measurements for all available models.
- 📊 **Dual-View Telemetry & Cumulative Aggregation (New in v1.1.0)**: Inspect both granular per-account usage and global lifetime aggregate token metrics (prompt tokens, completion tokens, total tokens, requests, and credit deductions across all stored accounts).

### 🏗️ Architecture

```
┌────────────────────────────────────────────────────────┐
│ OpenCode CLI / Terminal Agent                          │
│ (Reads ~/.config/opencode/opencode.json)               │
└──────────────────────────┬─────────────────────────────┘
                           │ OpenAI-compatible HTTP/SSE
                           ▼
┌────────────────────────────────────────────────────────┐
│ opencode-workbuddy-provider Gateway (127.0.0.1:18889)   │
│ ├─ Upstream 5.8.4 Header Injection (Resolves 11128)    │
│ ├─ DeepSeek Thinking Negotiation (Reasoning Effort)    │
│ ├─ SSE Stream Multiplexer & Token Telemetry            │
│ └─ Dual-Region Route Dispatcher                        │
└──────────────────────────┬─────────────────────────────┘
                           │ HTTPS (with official signatures)
                           ▼
┌────────────────────────────────────────────────────────┐
│ Upstream WorkBuddy / CodeBuddy Core APIs               │
└────────────────────────────────────────────────────────┘
```

### 💻 Quick Start

#### Mode A: Terminal OpenCode CLI (Recommended)

No GUI required. Run directly in any headless server or terminal:

```bash
# 1. Clone repository & install dependencies
git clone https://github.com/Thelast0802/opencode-workbuddy-provider.git
cd opencode-workbuddy-provider
npm install

# 2. Authenticate in terminal (opens browser auth & auto-injects opencode.json)
node service/index.js --login

# (Optional: specify --china for CodeBuddy CN)
# node service/index.js --china --login

# 3. Start local gateway daemon
node service/index.js

# 4. Use OpenCode
opencode
```

#### Mode B: OpenChamber Desktop GUI

1. Download `workbuddy-extension-windows.zip` or `workbuddy-extension.zip` from [Releases](https://github.com/Thelast0802/opencode-workbuddy-provider/releases).
2. Open OpenChamber **Settings → Extensions → Install Extension** and select the zip.
3. Access the WorkBuddy icon 🌐 on the left navigation bar.

### 🗺️ Project Roadmap

- [x] Dual-region (International & China) profile isolation
- [x] Client signature & W3C distributed trace header emulation
- [x] DeepSeek V4.1 Flash reasoning & thinking stream pass-through
- [x] OpenCode `capabilities.reasoning` manifest registration
- [x] Multi-account pool rotation & real-time switching (v1.1.0)
- [x] Protocol hardening, version sync & anti-ban quarantine circuit-breaker (v1.2.0)
- [ ] Automated continuous benchmarking of model latency & accuracy
- [ ] OpenAI Codex / Copilot CLI compatible fallback adapter
- [ ] Automated GitHub Actions release pipeline for cross-platform installers

---

<a name="中文说明"></a>
## 中文说明

专为 **[OpenCode](https://opencode.ai)** 打造的腾讯 WorkBuddy / CodeBuddy 原生模型 Provider 与本地代理网关，同时深度适配 **[OpenChamber](https://github.com/openchamber)** 图形化扩展面板。

一键接入 GPT-6、Claude-3.5-Sonnet、Gemini-3.5、DeepSeek-V4.1-Flash、GLM、Kimi 等海量模型，解决上游 11128 渠道拦截，原生支持 DeepSeek 深度思考（Thinking / Reasoning）。

### ✨ 核心特性

- 🎯 **以 OpenCode CLI 为核心**：无缝打通 OpenCode 配置体系（`~/.config/opencode/opencode.json`），命令行一键登录授权并自动同步模型，终端开发者开箱即用。
- 👥 **多账号池与热切换（v1.1.0）**：内置多账号存储池，集中纳管已登录的多个国际版与中国版账号。UI 下拉菜单与命令行（`--switch <ID>`）均支持实时热切账号，零停机无缝切换；自动捕获并标记上游 11140 账号风控状态。
- 🛡️ **协议全面加固与防封号体系（v1.2.0 新增）**：集成加固补丁，全方位防护小号避免异常封禁：
  - **客户端版本自适应动态同步**：自动嗅探宿主机本地安装的 WorkBuddy / CodeBuddy 及 `@genie/agent-cli` 真实版本（全平台适配 macOS / Windows / Linux），修正 `X-IDE-Type: CLI` 标头，告别硬编码陈旧版本引发的指纹异常风控。
  - **提示词特征清洗与隐形断点（Identity Sanitizer）**：针对 OpenCode、Claude Code、Roo Code 等智能体 Prompt 特征自动前置合规官方标头中和，并在敏感身份短语中插入 `\u200B` 零宽空格断点，绕过网关关键词封杀。
  - **11140 账号熔断防连坐（Account Quarantine）**：一旦收到 `11140`（账号存在异常行为），立即熔断单账号并**禁止账号池自动连坐重试**，彻底阻断因同一提示词触发的多账号连环封禁（Chain-Ban）。
  - **6004 单模型限流平滑迂回（Model Detour）**：捕获单模型速率限制（`6004`）后，在**同一账号内**自动平滑切换至同级候选模型（如 `hy4-preview` / `glm-5.3` / `kimi-k2.8-preview`），绝不滥用与耗尽其它小号。
- 🖥️ **深度适配 OpenChamber**：内置完整的 Webview 侧栏扩展面板，支持测速全部、模型独立开关、实时额度校准、用量统计及加固状态指示。
- 🛡️ **对齐官方 5.8.4 客户端抓包**：出站请求完整注入官方会话头族（`X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`、`X-Root-Request-ID`）与 W3C 分布式追踪链路头，**彻底解决上游 11128 渠道校验（Channel Verification）拦截**。
- 🧠 **深度思考（Thinking / Reasoning）支持**：全面适配 DeepSeek 系列（DeepSeek V4.1 Flash / R1 等），网关层自动维护思维链激活规则，向 OpenCode / OpenChamber 声明 `capabilities.reasoning`，UI 界面实时展现思考折叠框与档位选择。
- 🌐 **双版本自由切换**：支持「国际版 WorkBuddy (`workbuddy.ai`)」与「中国版 CodeBuddy (`copilot.tencent.com`)」，独立存储凭据与模型清单，终端与 UI 均支持快速切换。
- 📊 **双重视角用量统计与全局累计求和（v1.1.0 新增）**：支持一键切换「当前激活账号用量」与「插件全局累计汇总」，完整统计输入 Token、输出 Token、总 Token、请求次数及各个账号累计消耗积分。
- 💻 **跨平台原生兼容**：Windows / macOS / Linux 深度适配，自动兼容 Windows `%APPDATA%\opencode` 与 POSIX 文件系统权限。

### 🚀 快速上手

#### 方式一：终端 OpenCode CLI 独立使用

```bash
# 1. 克隆并安装
git clone https://github.com/Thelast0802/opencode-workbuddy-provider.git
cd opencode-workbuddy-provider
npm install

# 2. 命令行登录（浏览器授权后自动写入 opencode.json）
node service/index.js --login

# 3. 启动后台网关
node service/index.js

# 4. 任意目录畅享 OpenCode
opencode
```

#### 方式二：OpenChamber 图形化面板安装

1. 在 [Releases](https://github.com/Thelast0802/opencode-workbuddy-provider/releases) 页面下载 `workbuddy-extension-windows.zip` 或 `workbuddy-extension.zip`。
2. 在 OpenChamber 的 **设置 → 扩展** 中点击“安装扩展”并选择压缩包。
3. 侧栏点击 WorkBuddy 图标，即可使用图形化面板管理模型与测速。

---

## 🤝 上级源项目与技术致谢 (Upstream & Acknowledgments)

本项目在演进与打磨过程中，深度参考并受益于开源社区的多项优秀成果，特此致敬：

1. **[Ebony-Vinyl/dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)**  
   - 本项目最初的灵感来源与 OpenChamber 插件架构原型参考。

2. **[wzs39/dsh-workbuddy-hardened](https://github.com/wzs39/dsh-workbuddy-hardened)**  
   - 感谢作者贡献的协议加固系列补丁（版本自适应同步、提示词特征隐形断点清洗、11140 封号熔断与防连坐、6004 单模型限流平滑迂回机制），为本项目 v1.2.0 防风控体系提供了核心实现依据。

3. **[ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub)** & **[Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)**  
   - 感谢项目维护者在逆向对齐腾讯官方 WorkBuddy 5.8.4 客户端协议方面的卓越贡献。本项目深度参考了其抓包成果，完整补齐了 `X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`、`X-Root-Request-ID` 等出站会话头族与分布式链路追踪标头，从而彻底攻克了上游 11128 渠道拦截难题；同时参考了其针对 DeepSeek 深度思考生效规则的分析。

3. **[user_c8ead9ef/workbuddy-daily-claim](https://www.skillhub.cn/skills/user_c8ead9ef/workbuddy-daily-claim)**  
   - 感谢作者阿布在 SkillHub 发布的 WorkBuddy 自动签到技能。该项目对加油站签到积分（`total_credits`）与账户可用积分余额口径差异的技术分析，为我们明确了真实余额的追踪与计费机制。

4. **[OpenCode](https://opencode.ai)** & **[OpenChamber](https://github.com/openchamber)**  
   - 感谢 OpenCode 核心团队与 OpenChamber 团队提供的优秀 AI 编程环境及 `@openchamber/sdk` 拓展框架。

5. **[Tencent WorkBuddy / CodeBuddy](https://workbuddy.ai)**  
   - 腾讯官方 AI 编码助手团队提供的服务平台。

---

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE) 开源。
