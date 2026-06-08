---
name: mqtt-device-debugger
description: "当在 Aily Blockly 或 Aily Chat AI IDE 中开发或调试使用 MQTT 的 MCU 固件时使用，包括 broker 设置、MQTT over WebSocket、topics、QoS、retained messages、payload 设计、连接失败、publish/subscribe 测试，以及 child/tools/mqtt-debugger 工具。"
---

# MQTT 设备调试器

使用此 skill 通过 Aily 的 MQTT Debugger 子工具设计、测试和调试 MCU MQTT 行为。

## 首轮排查

先确认 MQTT 路径和预期设备行为：

1. 确认开发板、固件栈、Wi-Fi 或 Ethernet transport，以及 MQTT library。
2. 记录 broker URL、protocol scheme、port、path、TLS requirement、username/password，以及工具是否必须使用 MQTT over WebSocket。
3. 列出预期 publish topics、subscribe topics、QoS、retained message 行为、payload encoding，以及 command/telemetry 方向。
4. 只有当失败阶段会改变调试路径时才追问：Wi-Fi offline、broker unreachable、TLS failure、MQTT connect refused、subscribe silent、publish not received、retained state stale 或 payload decoded incorrectly。
5. 将该工具视作 MCU 固件的 AI IDE 调试器；把每个工具结果关联回 firmware logs、topic contracts 和 device state transitions。

## MQTT 规则

先设计 topic 和 payload contract，再修改固件：

- 保持 topic 方向明确，例如 `device/<id>/telemetry`、`device/<id>/state` 和 `device/<id>/cmd`。
- 除非有明确 routing 原因，否则不要在固件中使用 wildcard subscriptions。wildcard 主要用于调试。
- 有意选择 QoS。高频 telemetry 用 QoS 0；当 command delivery 比重复更重要时用 QoS 1。
- retained messages 只用于持久 state，不用于一次性 command。
- 明确定义 payload 格式：plain text、JSON、binary hex、numeric scaling、units、valid ranges 和 required fields。
- 为命令提供确定的 acknowledgement path，可以是 response topic 或 state topic update。
- MQTT callbacks 要短。解析消息、排队工作，然后快速返回。

## 调试器工具边界

使用现有 child tool 边界：

- `child/tools/index.json` 注册 `mqtt-debugger`，route 为 `/child-tool/mqtt-debugger`。
- `src/app/services/child-tool-process.service.ts` 使用 `node index.js serve --host 127.0.0.1 --port 0` 启动 backend。
- `src/app/tools/child-tool-host/child-tool-host.component.ts` 嵌入 UI，通过 query params 传递 language/theme，并通过 Penpal 交换 host context。
- `child/tools/mqtt-debugger/index.js` 选择 RPC、serve 或 CLI mode。
- `child/tools/mqtt-debugger/server.js` 提供 UI、托管 `/ws`、校验 token、映射 backend RPC methods，并暴露 `/health` 和 `/api/shutdown`。
- `child/tools/mqtt-debugger/core.js` 当前只拥有 backend status/shutdown。
- `child/tools/mqtt-debugger/ui/app.js` 拥有交互式 MQTT WebSocket client：broker connection、MQTT CONNECT/PING/SUBSCRIBE/PUBLISH packets、topic subscriptions、messages 和 logs。
- `child/tools/mqtt-debugger/i18n/*.json` 拥有 child-tool UI 文本。添加可见字符串时要更新每个 locale 文件。

不要把 MQTT broker communication 移到 Angular host。如果以后需要 backend MQTT support，把 transport logic 放在 `core.js`，通过 `server.js` 暴露，并同步更新 UI calls。

## CLI 检查

从 repo root 使用这些命令：

```powershell
node child/tools/mqtt-debugger/index.js --help
node child/tools/mqtt-debugger/index.js status
```

交互式 MQTT workflow 在 child browser UI 中通过 MQTT WebSocket brokers 运行。如果物理 broker 或 MCU 不可用，用 `--help`、`status`、`/health` 和代码级检查验证工具接线，不要编造 broker 结果。

## 调试路径

沿失败阶段排查：

- Broker unreachable：验证 protocol scheme、port、WebSocket path、DNS、firewall、TLS，以及 broker 是否支持 MQTT over WebSocket。
- Connect refused：检查 client ID uniqueness、username/password、clean session、keepalive、broker ACLs、TLS/SNI 和 MQTT protocol version support。
- Subscribe silent：验证 topic spelling、wildcard shape、QoS、broker ACLs、MCU 是否发布到同一 namespace，以及消息是否 retained。
- Publish not received by the MCU：检查 device subscription topic、retained flag、QoS、payload encoding，以及固件在 Wi-Fi loss 后 reconnect 时是否重新 subscribe。
- Payload wrong：比较 expected JSON keys、string versus numeric types、byte order、hex delimiters 和 unit scaling。
- UI is stuck：检查 stdout 上的 backend readiness JSON、WebSocket token/origin、`/health`、Penpal `childReady` 和 host overlay error。

## 固件指导

为 Aily 项目设计 MQTT 固件时：

- 为 Wi-Fi connect、broker connect、subscribe、publish、inbound topic、inbound payload length 和 reconnect attempts 添加 serial logs。
- 使用带 backoff 的 reconnect loop。每次成功 reconnect 后都要 resubscribe。
- 使用 QoS 1 时，让 command handlers 保持幂等。
- 避免在紧密 sensor loops 中不加限速地 publish。
- 除非用户明确提供测试凭据，否则 generated examples 中不要包含 secrets。
- 在回答中报告 test matrix：broker URL、client ID、subscribed topics、published topics、payload sample、expected device log 和 observed tool log。

## 修改工具

修改 MQTT Debugger 工具本身时：

- 将 backend lifecycle 和未来 Node MQTT transport behavior 放在 `core.js`。
- 将 static serving、token、WebSocket RPC、`/health` 和 shutdown behavior 放在 `server.js`。
- 将 CLI parsing 和 JSON output behavior 放在 `cli.js`。
- 将 MQTT packet/client behavior、UI state 和 message logs 放在 `ui/app.js`。
- 将 host lifecycle、iframe、restart 和 Penpal 问题放在 Angular child tool host 或 child tool process service。
- 除非 UI、CLI、server 和 host 一起更新，否则保持 JSON contract 稳定。

## 验证

选择与变更匹配的检查：

```powershell
python C:\Users\coloz\.codex\skills\.system\skill-creator\scripts\quick_validate.py child/tools/mqtt-debugger/skill/mqtt-device-debugger
node child/tools/mqtt-debugger/index.js --help
node child/tools/mqtt-debugger/index.js status
node --check child/tools/mqtt-debugger/index.js
node --check child/tools/mqtt-debugger/core.js
node --check child/tools/mqtt-debugger/cli.js
node --check child/tools/mqtt-debugger/server.js
node --check child/tools/mqtt-debugger/ui/app.js
```

对于 UI 或 Angular integration 变更，也运行：

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

对于真实 MQTT 行为，使用可达的 WebSocket broker 和 MCU firmware logs 验证，并报告 broker URL、topic、QoS、retained flag、payload 和 observed publish/subscribe result。
