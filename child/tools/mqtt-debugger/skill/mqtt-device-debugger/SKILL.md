---
name: mqtt-device-debugger
description: "Use when developing or debugging MCU firmware that uses MQTT in Aily Blockly or Aily Chat AI IDE, including broker setup, MQTT over WebSocket, topics, QoS, retained messages, payload design, connection failures, publish/subscribe tests, and the child/tools/mqtt-debugger tool."
---

# MQTT Device Debugger

Use this skill to help design, test, and debug MCU MQTT behavior with Aily's MQTT Debugger child tool.

## First Pass

Start by identifying the MQTT path and the expected device behavior:

1. Confirm the board, firmware stack, Wi-Fi or Ethernet transport, and MQTT library.
2. Capture the broker URL, protocol scheme, port, path, TLS requirement, username/password, and whether the tool must use MQTT over WebSocket.
3. List expected publish topics, subscribe topics, QoS, retained message behavior, payload encoding, and command/telemetry direction.
4. Ask for the exact failure stage only when it changes the path: Wi-Fi offline, broker unreachable, TLS failure, MQTT connect refused, subscribe silent, publish not received, retained state stale, or payload decoded incorrectly.
5. Treat the tool as an AI IDE debugger for MCU firmware; relate every tool result back to firmware logs, topic contracts, and device state transitions.

## MQTT Rules

Design the topic and payload contract before changing firmware:

- Keep topic direction explicit, such as `device/<id>/telemetry`, `device/<id>/state`, and `device/<id>/cmd`.
- Avoid using wildcard subscriptions in firmware unless there is a clear routing reason. Use wildcards mainly for debugging.
- Choose QoS intentionally. Use QoS 0 for high-rate telemetry and QoS 1 when command delivery matters more than duplication.
- Use retained messages only for durable state, not one-shot commands.
- Define payload format explicitly: plain text, JSON, binary hex, numeric scaling, units, valid ranges, and required fields.
- Include a deterministic acknowledgement path for commands, either a response topic or a state topic update.
- Keep MQTT callbacks short. Parse the message, queue the work, and return quickly.

## Debugger Tool Map

Use the existing child tool boundaries:

- `child/tools/index.json` registers `mqtt-debugger` with route `/child-tool/mqtt-debugger`.
- `src/app/services/child-tool-process.service.ts` starts the backend with `node index.js serve --host 127.0.0.1 --port 0`.
- `src/app/tools/child-tool-host/child-tool-host.component.ts` embeds the UI, passes language/theme through query params, and exchanges host context through Penpal.
- `child/tools/mqtt-debugger/index.js` selects RPC, serve, or CLI mode.
- `child/tools/mqtt-debugger/server.js` serves the UI, hosts `/ws`, validates the token, maps backend RPC methods, and exposes `/health` plus `/api/shutdown`.
- `child/tools/mqtt-debugger/core.js` currently owns backend status/shutdown only.
- `child/tools/mqtt-debugger/ui/app.js` owns the interactive MQTT WebSocket client: broker connection, MQTT CONNECT/PING/SUBSCRIBE/PUBLISH packets, topic subscriptions, messages, and logs.
- `child/tools/mqtt-debugger/i18n/*.json` owns child-tool UI text. Update every locale file when adding visible strings.

Do not move MQTT broker communication into the Angular host. If backend MQTT support is needed later, put transport logic in `core.js`, expose it through `server.js`, and update UI calls together.

## CLI Checks

Use these commands from the repo root:

```powershell
node child/tools/mqtt-debugger/index.js --help
node child/tools/mqtt-debugger/index.js status
```

The interactive MQTT workflow runs in the child browser UI over MQTT WebSocket brokers. If the physical broker or MCU is unavailable, verify tool wiring with `--help`, `status`, `/health`, and code-level checks instead of inventing broker results.

## Debugging Path

Follow the failing stage:

- Broker unreachable: verify protocol scheme, port, WebSocket path, DNS, firewall, TLS, and whether the broker supports MQTT over WebSocket.
- Connect refused: check client ID uniqueness, username/password, clean session, keepalive, broker ACLs, TLS/SNI, and MQTT protocol version support.
- Subscribe silent: verify topic spelling, wildcard shape, QoS, broker ACLs, whether the MCU publishes to the same namespace, and whether the message is retained.
- Publish not received by the MCU: check the device subscription topic, retained flag, QoS, payload encoding, and whether firmware reconnects resubscribe after Wi-Fi loss.
- Payload wrong: compare expected JSON keys, string versus numeric types, byte order, hex delimiters, and unit scaling.
- UI is stuck: check backend readiness JSON on stdout, WebSocket token/origin, `/health`, Penpal `childReady`, and the host overlay error.

## Firmware Guidance

When designing MQTT firmware for Aily projects:

- Add serial logs for Wi-Fi connect, broker connect, subscribe, publish, inbound topic, inbound payload length, and reconnect attempts.
- Use a reconnect loop with backoff. Resubscribe after every successful reconnect.
- Make command handlers idempotent when QoS 1 is used.
- Avoid publishing inside tight sensor loops without rate limiting.
- Keep secrets out of generated examples unless the user explicitly provides test credentials.
- Report a test matrix in the answer: broker URL, client ID, subscribed topics, published topics, payload sample, expected device log, and observed tool log.

## Modifying The Tool

When changing the MQTT Debugger tool itself:

- Put backend lifecycle and future Node MQTT transport behavior in `core.js`.
- Put static serving, token, WebSocket RPC, `/health`, and shutdown behavior in `server.js`.
- Put CLI parsing and JSON output behavior in `cli.js`.
- Put MQTT packet/client behavior, UI state, and message logs in `ui/app.js`.
- Put host lifecycle, iframe, restart, and Penpal issues in the Angular child tool host or child tool process service.
- Keep the JSON contract stable unless the UI, CLI, server, and host are updated together.

## Verification

Choose checks that match the change:

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

For UI or Angular integration changes, also run:

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

For real MQTT behavior, verify with a reachable WebSocket broker and MCU firmware logs, then report the broker URL, topic, QoS, retained flag, payload, and observed publish/subscribe result.
