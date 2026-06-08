---
name: ble-device-debugger
description: "当在 Aily Blockly 或 Aily Chat AI IDE 中开发或调试 MCU BLE 固件时使用，包括 GATT 服务设计、UUID 规划、BLE 广播、扫描、连接、读取、写入、通知、载荷格式、适配器状态问题，以及 child/tools/ble-debugger 工具。"
---

# BLE 设备调试器

使用此 skill 通过 Aily 的 BLE Debugger 子工具设计、测试和调试 MCU BLE 行为。

## 首轮排查

先确认 BLE 角色和预期协议：

1. 确认用户设备是 BLE peripheral、central，还是两者兼有。
2. 确认开发板、固件栈和库族，例如 ESP32 Arduino BLE、NimBLE 或其他 BLE 栈。
3. 记录广播设备名、已知 MAC/address、广播 service UUID，以及设备是否应当可连接。
4. 列出预期 GATT services、characteristics、properties、value formats 和 notification 行为。
5. 只有当症状会改变调试路径时才追问精确现象：扫描不到、能看到但无法连接、GATT 缺失、读写失败、通知无数据、载荷解码错误，或适配器不可用。
6. 将该工具视作 MCU 固件的 AI IDE 调试器；把每个 scan、GATT、read、write 或 notify 结果关联回固件代码和设备日志。

如果任务涉及生成或修改 Aily Blockly 设备固件，并且 ABS 或 Blockly library 语法重要，也加载 `abs-syntax-reference` 或 `blockly-best-practices`。

## GATT 设计规则

先设计 BLE 表面，再写固件：

- 仅对 Bluetooth SIG 已采用的服务和特征使用标准 16-bit UUID。产品自定义服务使用稳定的 128-bit custom UUID。
- 保持每个 characteristic 的职责清晰：read 用于状态，write 或 writeWithoutResponse 用于命令，notify 或 indicate 用于异步事件。
- 明确定义 payload 格式：hex bytes、ASCII text、UTF-8 JSON、binary struct、字节序、缩放、单位和有效范围。
- 命令确认要确定。对会改变设备状态的 write，优先提供可读 status characteristic 或 notification response。
- 避免在 BLE callbacks 内执行阻塞工作。尤其是 sensor read、flash write、Wi-Fi 或 serial logging，应排队后快速返回。
- 将 MTU 和 packet size 视作约束。大 payload 要拆包，或使用带 length、sequence 和 checksum 的 framed protocol。
- 比较 UUID 前先规范化字符串。不要在没有 normalization 的情况下混用 16-bit、32-bit、带横线 128-bit 和紧凑 128-bit 格式。

## 调试器工具边界

使用现有 child tool 边界：

- `child/tools/index.json` 注册 `ble-debugger`，route 为 `/child-tool/ble-debugger`。
- `src/app/services/child-tool-process.service.ts` 使用 `node index.js serve --host 127.0.0.1 --port 0` 启动 backend。
- `src/app/tools/child-tool-host/child-tool-host.component.ts` 嵌入 UI，通过 query params 传递 language/theme，并通过 Penpal 交换 host context。
- `child/tools/ble-debugger/index.js` 选择 RPC、serve 或 CLI mode。
- `child/tools/ble-debugger/server.js` 提供 UI、托管 `/ws`、校验 token、把 UI methods 映射到 backend actions，并广播 backend events。
- `child/tools/ble-debugger/core.js` 通过 `@abandonware/noble` 拥有 BLE 实现：adapter state、scanning、connection、GATT discovery、reads、writes、subscriptions、selector-based operations 和 cleanup。
- `child/tools/ble-debugger/ui/app.js` 渲染 scan、GATT、operation 和 log panels，并调用 WebSocket RPC API。
- `child/tools/ble-debugger/i18n/*.json` 拥有 child-tool UI 文本。添加可见字符串时要更新每个 locale 文件。

除非用户明确要求浏览器-only 实现，不要把 Node `@abandonware/noble` backend 替换成 browser Web Bluetooth。在此应用中，Electron 会启动 Node child process，因此预期 BLE 路径是 Node backend。

## CLI 检查

有物理适配器或设备时，从 repo root 使用这些命令：

```powershell
npm install --prefix child/tools/ble-debugger
node child/tools/ble-debugger/index.js --help
node child/tools/ble-debugger/index.js status
node child/tools/ble-debugger/index.js scan --duration-ms 5000 --service 180D
node child/tools/ble-debugger/index.js gatt --name-contains MyDevice --scan-ms 10000
node child/tools/ble-debugger/index.js read --id <device-id> --service <uuid> --characteristic <uuid>
node child/tools/ble-debugger/index.js write --id <device-id> --service <uuid> --characteristic <uuid> --payload "01 02" --mode hex
node child/tools/ble-debugger/index.js notify --id <device-id> --service <uuid> --characteristic <uuid> --duration-ms 10000
```

将 CLI 输出解释为 JSON。如果没有硬件，使用 `--help`、`status` 和代码级验证，不要编造扫描结果。

## 调试路径

沿失败阶段排查，不要修改无关层：

- Adapter unavailable：检查 OS Bluetooth 状态、权限、driver、`@abandonware/noble` 安装，以及是否有其他进程占用适配器。
- Not visible in scan：检查 adapter state、advertising enabled、device role、connectable flag、advertised service UUID filters、distance/RSSI 和 duplicate filtering。
- Visible but cannot connect：检查设备是否已被其他地方连接、固件是否停止广播、connection interval 约束，以及连接前是否应停止扫描。
- Connected but GATT is wrong：刷新 GATT，确认固件 service registration order，确认 custom UUIDs 已规范化；如果 OS 缓存了旧 GATT table，重启设备电源。
- Read fails：确认 characteristic 具有 `read`，设备接受当前 connection security level，并且 value callback 快速返回。
- Write fails：确认 `write` 与 `writeWithoutResponse`，校验 payload mode 和 hex format，并让 command payload 保持在 negotiated packet size 内。
- Notifications fail：确认 `notify` 或 `indicate`，在 GATT discovery 后订阅，保持连接存活，并验证固件在 value 更新后调用 notify API。
- Payload wrong：比较 byte order、text encoding、JSON shape、binary struct layout、delimiters、scaling 和 units。
- UI is stuck：检查 stdout 上的 backend readiness JSON、WebSocket token/origin、`/health`、Penpal `childReady` 和 host overlay error。

## 固件指导

为 Aily 项目设计 BLE 固件时：

- 保持 serial debug logs 简洁且非阻塞。日志对 bring-up 有用，但不应淹没 BLE callbacks。
- 使用唯一的 UUID 字符串来源。
- 对 ESP32，内存压力重要时选择 NimBLE；除非开发板和库支持，否则不要混用 classic Bluetooth 和 BLE 示例。
- 添加简单自测路径：advertise，暴露可读 firmware/version characteristic，接受小 write command，然后发出 notification。
- 保持 connection callbacks、read callbacks、write callbacks 和 notification producers 简短且确定。
- 在回答中报告 test matrix：scan result、GATT map、read value、write payload、notification event、expected device log 和 observed tool result。

## 修改工具

修改 BLE Debugger 工具本身时：

- 将 BLE transport、adapter state、scanning、connection、GATT、read/write/notify、selector helpers 和 cleanup 修复放在 `core.js`。
- 将 server、static serving、token、WebSocket RPC、event broadcast、`/health` 和 shutdown 修复放在 `server.js`。
- 将 CLI parsing、command examples 和 JSON output behavior 放在 `cli.js`。
- 将 UI state/rendering behavior 放在 `ui/app.js`，样式放在 `ui/*.css`。
- 将 host lifecycle、iframe、restart 和 Penpal 问题放在 Angular child tool host 或 child tool process service，不要放到 BLE backend。
- 除非 UI、CLI、server 和 host 一起更新，否则保持 JSON contract 稳定。

## 验证

选择与变更匹配的最小检查：

```powershell
python C:\Users\coloz\.codex\skills\.system\skill-creator\scripts\quick_validate.py child/tools/ble-debugger/skill/ble-device-debugger
node child/tools/ble-debugger/index.js --help
node child/tools/ble-debugger/index.js status
node --check child/tools/ble-debugger/index.js
node --check child/tools/ble-debugger/core.js
node --check child/tools/ble-debugger/cli.js
node --check child/tools/ble-debugger/server.js
node --check child/tools/ble-debugger/ui/app.js
```

对于 UI 或 Angular integration 变更，也运行：

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

对于 BLE 行为变更，尽可能使用真实硬件验证，并报告 adapter state、device selector、service UUID、characteristic UUID、payload 和 observed JSON result。
