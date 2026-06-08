---
name: industrial-bus-device-debugger
description: "Use when developing or debugging MCU industrial bus firmware in Aily Blockly or Aily Chat AI IDE, including CAN, CAN FD, RS485, Modbus RTU, Modbus TCP, CRC16, frame parsing, register maps, serial settings, payload hex, and the child/tools/industrial-bus-debugger tool."
---

# Industrial Bus Device Debugger

Use this skill to design, build, parse, and debug MCU industrial bus traffic with Aily's Industrial Bus Debugger child tool.

## First Pass

Start by identifying the bus and the expected frame:

1. Confirm the MCU board, transceiver, bus type, wiring, voltage level, termination, and firmware library.
2. For CAN, capture bitrate, standard versus extended ID, data versus remote frame, CAN FD usage, DLC, filter ID/mask, and expected payload.
3. For RS485, capture port, baud rate, data bits, stop bits, parity, direction-control pin behavior, and payload mode.
4. For Modbus, capture RTU versus TCP, unit ID, function code, address base, quantity, register map, endian order, expected response, and CRC/MBAP details.
5. Ask for the exact failure stage only when it changes the path: no physical traffic, frame format invalid, CRC mismatch, silent slave, exception response, wrong register value, or UI parse/build mismatch.

## Protocol Rules

Design the frame contract before changing firmware:

- Keep hex payloads byte-oriented and explicit. State endian order and scaling for every multi-byte value.
- For CAN, validate ID range: standard IDs are 0x000-0x7FF and extended IDs are 0x00000000-0x1FFFFFFF.
- For CAN FD, verify both tool and firmware agree on payload length and data phase bitrate before using more than 8 bytes.
- For RS485, verify half-duplex direction timing, bus biasing, termination, and shared ground before blaming protocol code.
- For Modbus RTU, CRC16 is little-endian on the wire. For Modbus TCP, use MBAP and no RTU CRC.
- Clarify whether register addresses are zero-based protocol addresses or one-based documentation labels.
- Treat exception responses as useful evidence, not just failures.

## Debugger Tool Map

Use the existing child tool boundaries:

- `child/tools/index.json` registers `industrial-bus-debugger` with route `/child-tool/industrial-bus-debugger`.
- `src/app/services/child-tool-process.service.ts` starts the backend with `node index.js serve --host 127.0.0.1 --port 0`.
- `src/app/tools/child-tool-host/child-tool-host.component.ts` embeds the UI, passes language/theme through query params, and exchanges host context through Penpal.
- `child/tools/industrial-bus-debugger/index.js` selects RPC, serve, or CLI mode.
- `child/tools/industrial-bus-debugger/server.js` serves the UI, hosts `/ws`, validates the token, maps RPC methods, and exposes `/health` plus `/api/shutdown`.
- `child/tools/industrial-bus-debugger/core.js` owns CAN frame validation/parsing, RS485 payload formatting, Modbus request building, Modbus response parsing, CRC16, MBAP, and log records.
- `child/tools/industrial-bus-debugger/ui/app.js` renders CAN, RS485, and Modbus tabs and calls the WebSocket RPC API.
- `child/tools/industrial-bus-debugger/i18n/*.json` owns child-tool UI text. Update every locale file when adding visible strings.

The current tool is a frame builder/parser and AI IDE debugging aid. Do not claim physical CAN or RS485 transmit happened unless real hardware integration is present and verified.

## CLI Checks

Use these commands from the repo root:

```powershell
node child/tools/industrial-bus-debugger/index.js --help
node child/tools/industrial-bus-debugger/index.js status
node child/tools/industrial-bus-debugger/index.js can-send --frame-id 123 --payload "01 02 03 04"
node child/tools/industrial-bus-debugger/index.js can-parse --trace "123#DEADBEEF"
node child/tools/industrial-bus-debugger/index.js rs485-tx --payload "01 03 00 00 00 02" --append-crc true
node child/tools/industrial-bus-debugger/index.js modbus-build --protocol rtu --unit-id 1 --function 03 --address 0 --quantity 2
node child/tools/industrial-bus-debugger/index.js modbus-parse --protocol rtu --response-hex "01 03 04 00 2A 00 64 DA 3F"
```

All non-help CLI commands write one JSON object to stdout. Treat generated frames as protocol artifacts until verified on a bus analyzer or device log.

## Debugging Path

Follow the failing stage:

- No CAN traffic: verify transceiver enable, bitrate, termination, common ground, bus-off state, and whether ID filters hide the frame.
- CAN parse mismatch: check standard/extended ID, DLC, CAN FD setting, remote frame flag, payload hex, and filter mask.
- RS485 silent: verify A/B wiring, DE/RE direction timing, baud, parity, stop bits, slave address, and bus termination/biasing.
- Modbus CRC mismatch: recompute request bytes, confirm RTU versus TCP, append CRC only for RTU, and verify byte order.
- Modbus exception: decode function and exception code, then check address, quantity, access rights, and device-supported function codes.
- Wrong register value: check zero-based address, word order, signedness, scaling, and register count.
- UI is stuck: check backend readiness JSON on stdout, WebSocket token/origin, `/health`, Penpal `childReady`, and the host overlay error.

## Firmware Guidance

When designing industrial bus firmware:

- Add serial logs for bus settings, frame TX/RX hex, parsed fields, CRC result, and exception codes.
- Keep RS485 direction control deterministic: enable transmit, flush, then return to receive after the last byte leaves.
- Keep Modbus handlers bounded and avoid long blocking work inside request callbacks.
- Maintain one register map document and reuse it in firmware, tests, and AI answers.
- Report a test matrix in the answer: bus settings, request hex, expected response hex, parsed values, device log, and observed tool result.

## Modifying The Tool

When changing the Industrial Bus Debugger tool itself:

- Put protocol validation, frame building, parsing, CRC, and logs in `core.js`.
- Put static serving, token, WebSocket RPC, `/health`, and shutdown behavior in `server.js`.
- Put CLI parsing and JSON output behavior in `cli.js`.
- Put UI state, tab rendering, input forms, and log rendering in `ui/app.js`.
- Put host lifecycle, iframe, restart, and Penpal issues in the Angular child tool host or child tool process service.
- Keep CAN, RS485, and Modbus behavior consistent across UI and CLI.

## Verification

Choose checks that match the change:

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

For UI or Angular integration changes, also run:

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

For physical bus behavior, verify with a bus analyzer, USB adapter, or device-side serial logs and report the exact frame bytes.
