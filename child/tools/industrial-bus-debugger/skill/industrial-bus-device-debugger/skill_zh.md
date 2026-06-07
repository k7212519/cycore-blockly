---
name: industrial-bus-device-debugger
description: "当在 Aily Blockly 或 Aily Chat AI IDE 中开发或调试 MCU 工业总线固件时使用，包括 CAN、CAN FD、RS485、Modbus RTU、Modbus TCP、CRC16、frame parsing、register maps、serial settings、payload hex，以及 child/tools/industrial-bus-debugger 工具。"
---

# 工业总线设备调试器

使用此 skill 通过 Aily 的 Industrial Bus Debugger 子工具设计、构建、解析和调试 MCU 工业总线流量。

## 首轮排查

先确认总线和预期帧：

1. 确认 MCU board、transceiver、bus type、wiring、voltage level、termination 和 firmware library。
2. 对 CAN，记录 bitrate、standard versus extended ID、data versus remote frame、CAN FD usage、DLC、filter ID/mask 和 expected payload。
3. 对 RS485，记录 port、baud rate、data bits、stop bits、parity、direction-control pin behavior 和 payload mode。
4. 对 Modbus，记录 RTU versus TCP、unit ID、function code、address base、quantity、register map、endian order、expected response 和 CRC/MBAP details。
5. 只有当失败阶段会改变调试路径时才追问：no physical traffic、frame format invalid、CRC mismatch、silent slave、exception response、wrong register value 或 UI parse/build mismatch。

## 协议规则

先设计 frame contract，再修改固件：

- 保持 hex payloads 面向字节且明确。说明每个 multi-byte value 的 endian order 和 scaling。
- 对 CAN，验证 ID range：standard IDs 为 0x000-0x7FF，extended IDs 为 0x00000000-0x1FFFFFFF。
- 对 CAN FD，在使用超过 8 bytes 前，确认工具和固件都同意 payload length 和 data phase bitrate。
- 对 RS485，责怪 protocol code 前先验证 half-duplex direction timing、bus biasing、termination 和 shared ground。
- 对 Modbus RTU，CRC16 在线路上是 little-endian。对 Modbus TCP，使用 MBAP 且没有 RTU CRC。
- 澄清 register addresses 是 zero-based protocol addresses 还是 one-based documentation labels。
- 将 exception responses 视作有用证据，而不只是失败。

## 调试器工具边界

使用现有 child tool 边界：

- `child/tools/index.json` 注册 `industrial-bus-debugger`，route 为 `/child-tool/industrial-bus-debugger`。
- `src/app/services/child-tool-process.service.ts` 使用 `node index.js serve --host 127.0.0.1 --port 0` 启动 backend。
- `src/app/tools/child-tool-host/child-tool-host.component.ts` 嵌入 UI，通过 query params 传递 language/theme，并通过 Penpal 交换 host context。
- `child/tools/industrial-bus-debugger/index.js` 选择 RPC、serve 或 CLI mode。
- `child/tools/industrial-bus-debugger/server.js` 提供 UI、托管 `/ws`、校验 token、映射 RPC methods，并暴露 `/health` 和 `/api/shutdown`。
- `child/tools/industrial-bus-debugger/core.js` 拥有 CAN frame validation/parsing、RS485 payload formatting、Modbus request building、Modbus response parsing、CRC16、MBAP 和 log records。
- `child/tools/industrial-bus-debugger/ui/app.js` 渲染 CAN、RS485 和 Modbus tabs，并调用 WebSocket RPC API。
- `child/tools/industrial-bus-debugger/i18n/*.json` 拥有 child-tool UI 文本。添加可见字符串时要更新每个 locale 文件。

当前工具是 frame builder/parser 和 AI IDE debugging aid。除非真实硬件集成存在且已验证，不要声称发生了物理 CAN 或 RS485 transmit。

## CLI 检查

从 repo root 使用这些命令：

```powershell
node child/tools/industrial-bus-debugger/index.js --help
node child/tools/industrial-bus-debugger/index.js status
node child/tools/industrial-bus-debugger/index.js can-send --frame-id 123 --payload "01 02 03 04"
node child/tools/industrial-bus-debugger/index.js can-parse --trace "123#DEADBEEF"
node child/tools/industrial-bus-debugger/index.js rs485-tx --payload "01 03 00 00 00 02" --append-crc true
node child/tools/industrial-bus-debugger/index.js modbus-build --protocol rtu --unit-id 1 --function 03 --address 0 --quantity 2
node child/tools/industrial-bus-debugger/index.js modbus-parse --protocol rtu --response-hex "01 03 04 00 2A 00 64 DA 3F"
```

所有非 help CLI commands 都向 stdout 写入一个 JSON object。在 bus analyzer 或 device log 验证前，将 generated frames 视作 protocol artifacts。

## 调试路径

沿失败阶段排查：

- No CAN traffic：验证 transceiver enable、bitrate、termination、common ground、bus-off state，以及 ID filters 是否隐藏 frame。
- CAN parse mismatch：检查 standard/extended ID、DLC、CAN FD setting、remote frame flag、payload hex 和 filter mask。
- RS485 silent：验证 A/B wiring、DE/RE direction timing、baud、parity、stop bits、slave address 和 bus termination/biasing。
- Modbus CRC mismatch：重新计算 request bytes，确认 RTU versus TCP，仅对 RTU append CRC，并验证 byte order。
- Modbus exception：解码 function 和 exception code，然后检查 address、quantity、access rights 和 device-supported function codes。
- Wrong register value：检查 zero-based address、word order、signedness、scaling 和 register count。
- UI is stuck：检查 stdout 上的 backend readiness JSON、WebSocket token/origin、`/health`、Penpal `childReady` 和 host overlay error。

## 固件指导

设计 industrial bus firmware 时：

- 为 bus settings、frame TX/RX hex、parsed fields、CRC result 和 exception codes 添加 serial logs。
- 保持 RS485 direction control 确定：enable transmit、flush，然后在最后一个字节离开后返回 receive。
- 保持 Modbus handlers 有界，避免在 request callbacks 内执行长时间 blocking work。
- 维护一份 register map document，并在 firmware、tests 和 AI answers 中复用。
- 在回答中报告 test matrix：bus settings、request hex、expected response hex、parsed values、device log 和 observed tool result。

## 修改工具

修改 Industrial Bus Debugger 工具本身时：

- 将 protocol validation、frame building、parsing、CRC 和 logs 放在 `core.js`。
- 将 static serving、token、WebSocket RPC、`/health` 和 shutdown behavior 放在 `server.js`。
- 将 CLI parsing 和 JSON output behavior 放在 `cli.js`。
- 将 UI state、tab rendering、input forms 和 log rendering 放在 `ui/app.js`。
- 将 host lifecycle、iframe、restart 和 Penpal 问题放在 Angular child tool host 或 child tool process service。
- 保持 CAN、RS485 和 Modbus behavior 在 UI 与 CLI 之间一致。

## 验证

选择与变更匹配的检查：

```powershell
python C:\Users\coloz\.codex\skills\.system\skill-creator\scripts\quick_validate.py child/tools/industrial-bus-debugger/skill/industrial-bus-device-debugger
node child/tools/industrial-bus-debugger/index.js --help
node child/tools/industrial-bus-debugger/index.js status
node child/tools/industrial-bus-debugger/index.js modbus-build --protocol rtu --unit-id 1 --function 03 --address 0 --quantity 2
node child/tools/industrial-bus-debugger/index.js modbus-parse --protocol rtu --response-hex "01 03 04 00 2A 00 64 DA 3F"
node --check child/tools/industrial-bus-debugger/index.js
node --check child/tools/industrial-bus-debugger/core.js
node --check child/tools/industrial-bus-debugger/cli.js
node --check child/tools/industrial-bus-debugger/server.js
node --check child/tools/industrial-bus-debugger/ui/app.js
```

对于 UI 或 Angular integration 变更，也运行：

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

对于 physical bus behavior，使用 bus analyzer、USB adapter 或 device-side serial logs 验证，并报告 exact frame bytes。
