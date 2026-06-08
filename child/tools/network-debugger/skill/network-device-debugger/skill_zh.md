---
name: network-device-debugger
description: "当在 Aily Blockly 或 Aily Chat AI IDE 中开发或调试 MCU 固件网络功能时使用，包括 HTTP clients 或 servers、REST APIs、webhooks、WebSocket streams、headers、payloads、timeouts、TLS、connectivity failures，以及 child/tools/network-debugger 工具。"
---

# 网络设备调试器

使用此 skill 通过 Aily 的 Network Debugger 子工具调试 MCU HTTP 和 WebSocket 行为。

## 首轮排查

先确认网络角色和预期交换：

1. 确认开发板、固件栈、network interface、Wi-Fi/Ethernet 状态，以及 MCU 是 client、server，还是两者兼有。
2. 记录 URL 或 WebSocket endpoint、method、headers、body、timeout、TLS requirement 和 authentication method。
3. 列出预期 request/response status codes、content type、payload shape、retry policy 和 firmware-side log points。
4. 只有当失败阶段会改变调试路径时才追问：no IP、DNS failure、TCP refused、TLS failure、timeout、wrong status、body parse failure、WebSocket open failure，或 messages not arriving。
5. 将工具输出视作 MCU 固件调试证据，而不是 device-side logs 的替代品。

## 网络规则

先设计 exchange，再修改固件：

- 在 test case 中保持 URL、method、headers 和 body 确定。
- 明确定义 payload 格式：JSON、form data、plain text、binary、hex、units、required fields 和 optional fields。
- 设置适合 MCU 和 network path 的 timeouts。避免无限期阻塞 main loop。
- 对 TLS，验证 clock sync、CA certificate、SNI/hostname 和 memory budget。
- 对 WebSocket，定义 handshake headers、message type、ping/pong expectations、reconnect behavior 和 framing。
- 避免记录 secrets。在回答和示例中遮蔽 tokens、API keys 和 passwords。

## 调试器工具边界

使用现有 child tool 边界：

- `child/tools/index.json` 注册 `network-debugger`，route 为 `/child-tool/network-debugger`。
- `src/app/services/child-tool-process.service.ts` 使用 `node index.js serve --host 127.0.0.1 --port 0` 启动 backend。
- `src/app/tools/child-tool-host/child-tool-host.component.ts` 嵌入 UI，通过 query params 传递 language/theme，并通过 Penpal 交换 host context。
- `child/tools/network-debugger/index.js` 选择 RPC、serve 或 CLI mode。
- `child/tools/network-debugger/server.js` 提供 UI、托管 `/ws`、校验 token、映射 RPC methods，并暴露 `/health` 和 `/api/shutdown`。
- `child/tools/network-debugger/core.js` 通过 `fetch` 拥有 Node HTTP requests、header parsing、timeout handling、response body、response headers 和 status metadata。
- `child/tools/network-debugger/ui/app.js` 渲染 HTTP 和 WebSocket modes。HTTP 调用 backend RPC API；external WebSocket testing 在 browser UI 中运行。
- `child/tools/network-debugger/i18n/*.json` 拥有 child-tool UI 文本。添加可见字符串时要更新每个 locale 文件。

不要把 HTTP transport behavior 放到 Angular。Backend HTTP request behavior 属于 `core.js`；UI form state 和 external WebSocket interaction 属于 `ui/app.js`。

## CLI 检查

从 repo root 使用这些命令：

```powershell
node child/tools/network-debugger/index.js --help
node child/tools/network-debugger/index.js status
node child/tools/network-debugger/index.js request --url http://127.0.0.1:8080/health --method GET --timeout-ms 5000
node child/tools/network-debugger/index.js request --url https://example.com/api --method POST --header "Content-Type: application/json" --body "{\"ping\":true}"
```

所有非 help CLI commands 都向 stdout 写入一个 JSON object。如果 endpoint 不可用，报告该限制并运行代码级检查，不要编造 response。

## 调试路径

沿失败阶段排查：

- No IP：验证 Wi-Fi credentials、DHCP/static IP、antenna/power 和 firmware network events。
- DNS failure：用 IP address 测试，检查 DNS server、captive portal 和 hostname spelling。
- TCP refused：验证 server host/port、LAN reachability、firewall，以及 MCU 是否连接到正确网络。
- TLS failure：检查 clock、CA certificate、hostname/SNI、certificate chain、TLS version 和 memory pressure。
- Timeout：比较 firmware timeout、tool timeout、server latency、payload size 和 MCU 上的 blocking work。
- Wrong status/body：比较 method、path、headers、content type、auth、JSON shape 和 server-side validation。
- WebSocket silent：验证 handshake URL、scheme、headers、ping/pong、close codes，以及 MCU 在 Wi-Fi loss 后是否 reconnect。
- UI is stuck：检查 stdout 上的 backend readiness JSON、WebSocket token/origin、`/health`、Penpal `childReady` 和 host overlay error。

## 固件指导

设计 MCU network firmware 时：

- 为 IP acquired、DNS start/result、connect start/result、request line、status code、body length 和 parse result 添加 serial logs。
- 尽量保持 HTTP clients 非阻塞，或用显式 timeouts 约束 blocking calls。
- 为 generated firmware 和 tool test payloads 复用同一套 JSON schema。
- 对 WebSocket，发送一个小 hello frame 和周期性 heartbeat，让 silence 更容易诊断。
- 在回答中报告 test matrix：URL、method、headers、body sample、expected status/body、device log 和 observed tool result。

## 修改工具

修改 Network Debugger 工具本身时：

- 将 HTTP request、header parsing、response formatting 和 timeout behavior 放在 `core.js`。
- 将 static serving、token、WebSocket RPC、`/health` 和 shutdown behavior 放在 `server.js`。
- 将 CLI parsing 和 JSON output behavior 放在 `cli.js`。
- 将 UI state、HTTP form rendering、external WebSocket interaction 和 logs 放在 `ui/app.js`。
- 将 host lifecycle、iframe、restart 和 Penpal 问题放在 Angular child tool host 或 child tool process service。
- 除非 UI、CLI、server 和 host 一起更新，否则保持 JSON contract 稳定。

## 验证

选择与变更匹配的检查：

```powershell
python C:\Users\coloz\.codex\skills\.system\skill-creator\scripts\quick_validate.py child/tools/network-debugger/skill/network-device-debugger
node child/tools/network-debugger/index.js --help
node child/tools/network-debugger/index.js status
node --check child/tools/network-debugger/index.js
node --check child/tools/network-debugger/core.js
node --check child/tools/network-debugger/cli.js
node --check child/tools/network-debugger/server.js
node --check child/tools/network-debugger/ui/app.js
```

对于 UI 或 Angular integration 变更，也运行：

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

对于真实 network 行为，使用可达 endpoint 或 MCU server 验证，并报告 URL、method、headers used、body、status、duration 和 observed firmware log。
