---
name: ble-device-debugger
description: "Use when developing or debugging MCU BLE firmware in Aily Blockly or Aily Chat AI IDE, including GATT service design, UUID planning, BLE advertising, scanning, connecting, reading, writing, notifications, payload formats, adapter state issues, and the child/tools/ble-debugger tool."
---

# BLE Device Debugger

Use this skill to design, test, and debug MCU BLE behavior with Aily's BLE Debugger child tool.

## First Pass

Start by identifying the BLE role and the expected protocol:

1. Confirm whether the user's device is a BLE peripheral, central, or both.
2. Identify the board, firmware stack, and library family, such as ESP32 Arduino BLE, NimBLE, or another BLE stack.
3. Capture the advertised device name, MAC/address if known, advertised service UUIDs, and whether the device should be connectable.
4. List the expected GATT services, characteristics, properties, value formats, and notification behavior.
5. Ask for the exact symptom only when it changes the debugging path: not visible in scan, visible but cannot connect, GATT missing, read/write failing, notifications silent, payload decoded incorrectly, or adapter unavailable.
6. Treat the tool as an AI IDE debugger for MCU firmware; relate every scan, GATT, read, write, or notify result back to firmware code and device logs.

When the task is about generating or changing Aily Blockly device firmware, also load `abs-syntax-reference` or `blockly-best-practices` if ABS or Blockly-library syntax matters.

## GATT Design Rules

Design the BLE surface before writing firmware:

- Use standard 16-bit UUIDs only for adopted Bluetooth SIG services and characteristics. Use stable 128-bit custom UUIDs for product-specific services.
- Keep each characteristic role clear: read for state, write or writeWithoutResponse for commands, notify or indicate for asynchronous events.
- Define payload format explicitly: hex bytes, ASCII text, UTF-8 JSON, binary struct, endian order, scaling, units, and valid ranges.
- Keep command acknowledgements deterministic. Prefer a readable status characteristic or notification response for writes that change device state.
- Avoid blocking work inside BLE callbacks. Queue work and return quickly, especially when sensor reads, flash writes, Wi-Fi, or serial logging are involved.
- Treat MTU and packet size as constraints. Split large payloads or use a framed protocol with length, sequence, and checksum if needed.
- Normalize UUID strings before comparing them. Avoid mixing 16-bit, 32-bit, dashed 128-bit, and compact 128-bit forms without a normalization step.

## Debugger Tool Map

Use the existing child tool boundaries:

- `child/tools/index.json` registers `ble-debugger` with route `/child-tool/ble-debugger`.
- `src/app/services/child-tool-process.service.ts` starts the backend with `node index.js serve --host 127.0.0.1 --port 0`.
- `src/app/tools/child-tool-host/child-tool-host.component.ts` embeds the UI, passes language/theme through query params, and exchanges host context through Penpal.
- `child/tools/ble-debugger/index.js` selects RPC, serve, or CLI mode.
- `child/tools/ble-debugger/server.js` serves the UI, hosts `/ws`, validates the token, maps UI methods to backend actions, and broadcasts backend events.
- `child/tools/ble-debugger/core.js` owns the BLE implementation through `@abandonware/noble`: adapter state, scanning, connection, GATT discovery, reads, writes, subscriptions, selector-based operations, and cleanup.
- `child/tools/ble-debugger/ui/app.js` renders scan, GATT, operation, and log panels and calls the WebSocket RPC API.
- `child/tools/ble-debugger/i18n/*.json` owns child-tool UI text. Update every locale file when adding visible strings.

Do not replace the Node `@abandonware/noble` backend with browser Web Bluetooth unless the user explicitly asks for a browser-only implementation. In this app, Electron starts a Node child process so the intended BLE path is the Node backend.

## CLI Checks

Use these commands from the repo root when a physical adapter or device is available:

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

Interpret CLI output as JSON. If hardware is unavailable, use `--help`, `status`, and code-level verification instead of inventing scan results.

## Debugging Path

Follow the failure stage rather than changing unrelated layers:

- Adapter unavailable: check OS Bluetooth state, permissions, driver, `@abandonware/noble` install, and whether another process owns the adapter.
- Not visible in scan: check adapter state, advertising enabled, device role, connectable flag, advertised service UUID filters, distance/RSSI, and duplicate filtering.
- Visible but cannot connect: check whether the device is already connected elsewhere, whether firmware stops advertising, connection interval constraints, and whether scanning should stop before connecting.
- Connected but GATT is wrong: refresh GATT, verify firmware service registration order, confirm custom UUIDs are normalized, and power-cycle the device if the OS cached an old GATT table.
- Read fails: confirm the characteristic has `read`, the device accepts the connection security level, and the value callback returns promptly.
- Write fails: confirm `write` versus `writeWithoutResponse`, validate payload mode and hex format, and keep command payloads within the negotiated packet size.
- Notifications fail: confirm `notify` or `indicate`, subscribe after GATT discovery, keep the connection alive, and verify firmware calls the notify API after value updates.
- Payload wrong: compare byte order, text encoding, JSON shape, binary struct layout, delimiters, scaling, and units.
- UI is stuck: check backend readiness JSON on stdout, WebSocket token/origin, `/health`, Penpal `childReady`, and the host overlay error.

## Firmware Guidance

When designing BLE firmware for Aily projects:

- Keep serial debug logs concise and non-blocking. Logs are useful during bring-up, but should not flood BLE callbacks.
- Use one source of truth for UUID strings.
- For ESP32, choose NimBLE when memory pressure matters, and avoid mixing classic Bluetooth and BLE examples unless the board and library support it.
- Add a simple self-test path: advertise, expose a readable firmware/version characteristic, accept a small write command, then emit a notification.
- Keep connection callbacks, read callbacks, write callbacks, and notification producers short and deterministic.
- Report the test matrix in the answer: scan result, GATT map, read value, write payload, notification event, expected device log, and observed tool result.

## Modifying The Tool

When changing the BLE Debugger tool itself:

- Put BLE transport, adapter state, scanning, connection, GATT, read/write/notify, selector helpers, and cleanup fixes in `core.js`.
- Put server, static serving, token, WebSocket RPC, event broadcast, `/health`, and shutdown fixes in `server.js`.
- Put CLI parsing, command examples, and JSON output behavior in `cli.js`.
- Put UI state/rendering behavior in `ui/app.js` and styling in `ui/*.css`.
- Put host lifecycle, iframe, restart, and Penpal issues in the Angular child tool host or child tool process service, not in the BLE backend.
- Keep the JSON contract stable unless the UI, CLI, server, and host are updated together.

## Verification

Choose the smallest checks that match the change:

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

For UI or Angular integration changes, also run:

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

For BLE behavior changes, verify with real hardware when possible and report adapter state, device selector, service UUID, characteristic UUID, payload, and observed JSON result.
