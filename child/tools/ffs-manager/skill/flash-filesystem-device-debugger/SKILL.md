---
name: flash-filesystem-device-debugger
description: "Use when developing or debugging ESP MCU flash storage and filesystem workflows in Aily Blockly or Aily Chat AI IDE, including serial bootloader access, partition tables, SPIFFS, LittleFS, FATFS, flash read/write/erase, image export/import, file upload limits, BLE discovery, and the child/tools/ffs-manager tool."
---

# Flash Filesystem Device Debugger

Use this skill to debug ESP MCU flash partitions and filesystem contents with Aily's FFS Manager child tool.

## First Pass

Start by identifying the storage target and risk level:

1. Confirm the chip family, board, serial port, requested baud, flash size, partition scheme, and firmware framework.
2. Identify the target partition label, type/subtype, offset, size, and filesystem type: SPIFFS, LittleFS, FATFS, or normal data/app partition.
3. Capture the operation: read info, read partition table, export image, browse files, upload file, import image, write back, erase, or BLE scan.
4. Ask for the exact failure stage only when it changes the path: serial port busy, bootloader connect failed, partition table not found, filesystem mount failed, filename rejected, image write failed, erase failed, or BLE scan empty.
5. Treat destructive operations as high-risk. Confirm offsets, sizes, labels, and backups before erase, import, or write back.

## Storage Rules

Design and inspect before writing:

- Never erase or overwrite flash based only on a partition label. Confirm offset and size.
- Export the partition image before destructive work whenever a device is available.
- Keep filesystem type explicit. SPIFFS, LittleFS, and FATFS have different path, directory, block, and filename constraints.
- Respect filename byte limits used by the tool: SPIFFS 30 bytes, LittleFS 63 bytes, FATFS 255 bytes.
- Treat partition tables as binary structures at known offsets. This tool probes common offsets and parses entries with magic `0x50AA`.
- Keep serial ownership coordinated with other tools. FFS Manager asks the host to release/restore serial-monitor ownership around operations.
- Prefer the Node `serialport` and `esptool-js` path in Electron. Do not switch to browser Web Serial unless the user explicitly asks for a browser-only implementation.

## Debugger Tool Map

Use the existing child tool boundaries:

- `child/tools/index.json` registers `ffs-manager-child` with route `/child-tool/ffs-manager-child` and `childDir` `tools/ffs-manager`.
- `src/app/services/child-tool-process.service.ts` starts the backend with `node index.js serve --host 127.0.0.1 --port 0`.
- `src/app/tools/child-tool-host/child-tool-host.component.ts` embeds the UI, passes language/theme through query params, and exchanges host context through Penpal.
- `child/tools/ffs-manager/index.js` selects RPC, serve, or CLI mode.
- `child/tools/ffs-manager/server.js` serves the UI and WASM assets, hosts `/ws`, validates the token, maps RPC aliases, and exposes `/health` plus `/api/shutdown`.
- `child/tools/ffs-manager/core.js` owns serial port access, `esptool-js` sessions, flash reads/writes/erase, partition probing/parsing, BLE status/scan, and cleanup.
- `child/tools/ffs-manager/serial-port-adapter.js` adapts Node `serialport` to the transport API.
- `child/tools/ffs-manager/usb-bridge.js` resolves baud behavior for specific USB bridges.
- `child/tools/ffs-manager/ui/app.js` renders device info, partition map, filesystem explorer, image import/export, file upload/download, and host serial coordination.
- `child/tools/ffs-manager/ui/wasm/*` provides filesystem image operations for SPIFFS, LittleFS, and FATFS.
- `child/tools/ffs-manager/i18n/*.json` owns child-tool UI text. Update every locale file when adding visible strings.

Do not move serial, flash, or filesystem image logic into Angular. Keep transport and flash behavior in `core.js`; keep browser-side filesystem image manipulation in `ui/app.js` and WASM clients.

## CLI Checks

Use these commands from the repo root:

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

All non-help CLI commands write one JSON object to stdout. If hardware is unavailable, use `--help`, `status`, `ports`, and code-level checks instead of inventing flash or BLE results.

## Debugging Path

Follow the failing stage:

- Serial port missing: verify cable, driver, board power, OS device path, and whether another tool owns the port.
- Bootloader connect failed: check reset/boot buttons, DTR/RTS wiring, baud, USB bridge behavior, and whether serial-monitor was released.
- Partition table wrong: inspect detected offset, flash size, partition scheme, table magic, and whether firmware was built with the expected partition CSV.
- Filesystem mount failed: confirm partition type/subtype, filesystem type, image size, block/page assumptions, and whether the partition was formatted by a matching library.
- Upload rejected: check filename byte limit, path rules, remaining capacity, and SPIFFS directory limitations.
- Write back failed: verify exported backup, image size, port stability, baud, and that the target offset/size still match the selected partition.
- BLE scan empty: check adapter state, service UUID filter, power, advertising mode, and distance.
- UI is stuck: check backend readiness JSON on stdout, WebSocket token/origin, `/health`, Penpal `childReady`, host serial tool signals, and the overlay error.

## Firmware Guidance

When designing ESP filesystem firmware:

- Keep the partition scheme and filesystem type visible in project configuration and answers.
- Log filesystem mount result, total/used bytes, key file paths, and write failures.
- Keep generated filenames short enough for the target filesystem.
- Use a known test file such as `/aily_selftest.txt` to verify read/write after formatting.
- Avoid writing flash in tight loops; debounce file writes and check free space first.
- Report a test matrix in the answer: port, baud, chip, flash size, partition label/offset/size, filesystem type, operation, backup status, and observed result.

## Modifying The Tool

When changing the FFS Manager tool itself:

- Put serial, ESP loader, flash read/write/erase, partition parsing, BLE scan, and cleanup behavior in `core.js`.
- Put Node serial adapter behavior in `serial-port-adapter.js`.
- Put USB bridge baud selection in `usb-bridge.js`.
- Put static serving, WASM MIME type, token, WebSocket RPC aliases, `/health`, and shutdown behavior in `server.js`.
- Put CLI parsing and JSON output behavior in `cli.js`.
- Put UI state, filesystem explorer behavior, image import/export, file upload/download, and host serial coordination in `ui/app.js`.
- Put host lifecycle, iframe, restart, and Penpal issues in the Angular child tool host or child tool process service.
- Keep destructive action prompts and pre-checks close to the UI action and backend validation.

## Verification

Choose checks that match the change:

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

For UI or Angular integration changes, also run:

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

For flash behavior changes, verify with real hardware when possible and report port, baud, partition, offset, size, filesystem type, backup/export status, and observed JSON result.
