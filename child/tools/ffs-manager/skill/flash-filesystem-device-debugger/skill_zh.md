---
name: flash-filesystem-device-debugger
description: "当在 Aily Blockly 或 Aily Chat AI IDE 中开发或调试 ESP MCU flash storage 和 filesystem workflows 时使用，包括 serial bootloader access、partition tables、SPIFFS、LittleFS、FATFS、flash read/write/erase、image export/import、file upload limits、BLE discovery，以及 child/tools/ffs-manager 工具。"
---

# Flash 文件系统设备调试器

使用此 skill 通过 Aily 的 FFS Manager 子工具调试 ESP MCU flash partitions 和 filesystem contents。

## 首轮排查

先确认 storage target 和 risk level：

1. 确认 chip family、board、serial port、requested baud、flash size、partition scheme 和 firmware framework。
2. 确认 target partition label、type/subtype、offset、size 和 filesystem type：SPIFFS、LittleFS、FATFS 或 normal data/app partition。
3. 记录 operation：read info、read partition table、export image、browse files、upload file、import image、write back、erase 或 BLE scan。
4. 只有当失败阶段会改变调试路径时才追问：serial port busy、bootloader connect failed、partition table not found、filesystem mount failed、filename rejected、image write failed、erase failed 或 BLE scan empty。
5. 将 destructive operations 视作高风险。erase、import 或 write back 前确认 offsets、sizes、labels 和 backups。

## 存储规则

先设计和检查，再写入：

- 不要只根据 partition label erase 或 overwrite flash。必须确认 offset 和 size。
- 只要设备可用， destructive work 前先 export partition image。
- 保持 filesystem type 明确。SPIFFS、LittleFS 和 FATFS 的 path、directory、block 和 filename constraints 不同。
- 遵守工具使用的 filename byte limits：SPIFFS 30 bytes、LittleFS 63 bytes、FATFS 255 bytes。
- 将 partition tables 视作位于已知 offsets 的 binary structures。此工具会 probe 常见 offsets，并解析 magic 为 `0x50AA` 的 entries。
- 与其他工具协调 serial ownership。FFS Manager 会要求 host 在操作前后 release/restore serial-monitor ownership。
- 在 Electron 中优先使用 Node `serialport` 和 `esptool-js` 路径。除非用户明确要求 browser-only implementation，否则不要切换到 browser Web Serial。

## 调试器工具边界

使用现有 child tool 边界：

- `child/tools/index.json` 注册 `ffs-manager-child`，route 为 `/child-tool/ffs-manager-child`，`childDir` 为 `tools/ffs-manager`。
- `src/app/services/child-tool-process.service.ts` 使用 `node index.js serve --host 127.0.0.1 --port 0` 启动 backend。
- `src/app/tools/child-tool-host/child-tool-host.component.ts` 嵌入 UI，通过 query params 传递 language/theme，并通过 Penpal 交换 host context。
- `child/tools/ffs-manager/index.js` 选择 RPC、serve 或 CLI mode。
- `child/tools/ffs-manager/server.js` 提供 UI 和 WASM assets、托管 `/ws`、校验 token、映射 RPC aliases，并暴露 `/health` 和 `/api/shutdown`。
- `child/tools/ffs-manager/core.js` 拥有 serial port access、`esptool-js` sessions、flash reads/writes/erase、partition probing/parsing、BLE status/scan 和 cleanup。
- `child/tools/ffs-manager/serial-port-adapter.js` 将 Node `serialport` 适配到 transport API。
- `child/tools/ffs-manager/usb-bridge.js` 为特定 USB bridges 解析 baud behavior。
- `child/tools/ffs-manager/ui/app.js` 渲染 device info、partition map、filesystem explorer、image import/export、file upload/download 和 host serial coordination。
- `child/tools/ffs-manager/ui/wasm/*` 为 SPIFFS、LittleFS 和 FATFS 提供 filesystem image operations。
- `child/tools/ffs-manager/i18n/*.json` 拥有 child-tool UI 文本。添加可见字符串时要更新每个 locale 文件。

不要把 serial、flash 或 filesystem image logic 移入 Angular。Transport 和 flash behavior 保持在 `core.js`；browser-side filesystem image manipulation 保持在 `ui/app.js` 和 WASM clients。

## CLI 检查

从 repo root 使用这些命令：

```powershell
npm run install:ffs-manager
node child/tools/ffs-manager/index.js --help
node child/tools/ffs-manager/index.js status
node child/tools/ffs-manager/index.js ports
node child/tools/ffs-manager/index.js info --port COM3 --baud 921600
node child/tools/ffs-manager/index.js partitions --port COM3 --baud 921600
node child/tools/ffs-manager/index.js read --port COM3 --offset 0x290000 --size 0x170000 --baud 921600
node child/tools/ffs-manager/index.js erase --port COM3 --offset 0x290000 --size 0x170000 --baud 921600
node child/tools/ffs-manager/index.js ble-status
node child/tools/ffs-manager/index.js ble-scan --duration-ms 5000 --service 180D
```

所有非 help CLI commands 都向 stdout 写入一个 JSON object。如果没有硬件，使用 `--help`、`status`、`ports` 和代码级检查，不要编造 flash 或 BLE 结果。

## 调试路径

沿失败阶段排查：

- Serial port missing：验证 cable、driver、board power、OS device path，以及是否有其他工具占用 port。
- Bootloader connect failed：检查 reset/boot buttons、DTR/RTS wiring、baud、USB bridge behavior，以及 serial-monitor 是否已释放。
- Partition table wrong：检查 detected offset、flash size、partition scheme、table magic，以及固件是否使用预期 partition CSV 构建。
- Filesystem mount failed：确认 partition type/subtype、filesystem type、image size、block/page assumptions，以及 partition 是否由匹配 library 格式化。
- Upload rejected：检查 filename byte limit、path rules、remaining capacity 和 SPIFFS directory limitations。
- Write back failed：验证 exported backup、image size、port stability、baud，以及 target offset/size 是否仍匹配 selected partition。
- BLE scan empty：检查 adapter state、service UUID filter、power、advertising mode 和 distance。
- UI is stuck：检查 stdout 上的 backend readiness JSON、WebSocket token/origin、`/health`、Penpal `childReady`、host serial tool signals 和 overlay error。

## 固件指导

设计 ESP filesystem firmware 时：

- 在 project configuration 和回答中保持 partition scheme 与 filesystem type 可见。
- 记录 filesystem mount result、total/used bytes、key file paths 和 write failures。
- 让 generated filenames 足够短，满足目标 filesystem。
- 使用已知 test file，例如 `/aily_selftest.txt`，在 formatting 后验证 read/write。
- 避免在 tight loops 中写 flash；对 file writes 做 debounce，并先检查 free space。
- 在回答中报告 test matrix：port、baud、chip、flash size、partition label/offset/size、filesystem type、operation、backup status 和 observed result。

## 修改工具

修改 FFS Manager 工具本身时：

- 将 serial、ESP loader、flash read/write/erase、partition parsing、BLE scan 和 cleanup behavior 放在 `core.js`。
- 将 Node serial adapter behavior 放在 `serial-port-adapter.js`。
- 将 USB bridge baud selection 放在 `usb-bridge.js`。
- 将 static serving、WASM MIME type、token、WebSocket RPC aliases、`/health` 和 shutdown behavior 放在 `server.js`。
- 将 CLI parsing 和 JSON output behavior 放在 `cli.js`。
- 将 UI state、filesystem explorer behavior、image import/export、file upload/download 和 host serial coordination 放在 `ui/app.js`。
- 将 host lifecycle、iframe、restart 和 Penpal 问题放在 Angular child tool host 或 child tool process service。
- 将 destructive action prompts 和 pre-checks 保持在靠近 UI action 与 backend validation 的位置。

## 验证

选择与变更匹配的检查：

```powershell
python C:\Users\coloz\.codex\skills\.system\skill-creator\scripts\quick_validate.py child/tools/ffs-manager/skill/flash-filesystem-device-debugger
node child/tools/ffs-manager/index.js --help
node child/tools/ffs-manager/index.js status
node --check child/tools/ffs-manager/index.js
node --check child/tools/ffs-manager/core.js
node --check child/tools/ffs-manager/cli.js
node --check child/tools/ffs-manager/server.js
node --check child/tools/ffs-manager/serial-port-adapter.js
node --check child/tools/ffs-manager/usb-bridge.js
node --check child/tools/ffs-manager/ui/app.js
```

对于 UI 或 Angular integration 变更，也运行：

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

对于 flash behavior changes，尽可能使用真实硬件验证，并报告 port、baud、partition、offset、size、filesystem type、backup/export status 和 observed JSON result。
