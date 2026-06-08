---
name: network-device-debugger
description: "Use when developing or debugging MCU firmware network features in Aily Blockly or Aily Chat AI IDE, including HTTP clients or servers, REST APIs, webhooks, WebSocket streams, headers, payloads, timeouts, TLS, connectivity failures, and the child/tools/network-debugger tool."
---

# Network Device Debugger

Use this skill to debug MCU HTTP and WebSocket behavior with Aily's Network Debugger child tool.

## First Pass

Start by identifying the network role and the expected exchange:

1. Confirm the board, firmware stack, network interface, Wi-Fi/Ethernet state, and whether the MCU is a client, server, or both.
2. Capture the URL or WebSocket endpoint, method, headers, body, timeout, TLS requirement, and authentication method.
3. List expected request/response status codes, content type, payload shape, retry policy, and firmware-side log points.
4. Ask for the exact failure stage only when it changes the path: no IP, DNS failure, TCP refused, TLS failure, timeout, wrong status, body parse failure, WebSocket open failure, or messages not arriving.
5. Treat tool output as evidence for MCU firmware debugging, not as a replacement for device-side logs.

## Network Rules

Design the exchange before changing firmware:

- Keep URL, method, headers, and body deterministic in the test case.
- Define payload format explicitly: JSON, form data, plain text, binary, hex, units, required fields, and optional fields.
- Set timeouts that fit the MCU and network path. Avoid blocking the main loop indefinitely.
- For TLS, verify clock sync, CA certificate, SNI/hostname, and memory budget.
- For WebSocket, define handshake headers, message type, ping/pong expectations, reconnect behavior, and framing.
- Avoid logging secrets. Mask tokens, API keys, and passwords in answers and examples.

## Debugger Tool Map

Use the existing child tool boundaries:

- `child/tools/index.json` registers `network-debugger` with route `/child-tool/network-debugger`.
- `src/app/services/child-tool-process.service.ts` starts the backend with `node index.js serve --host 127.0.0.1 --port 0`.
- `src/app/tools/child-tool-host/child-tool-host.component.ts` embeds the UI, passes language/theme through query params, and exchanges host context through Penpal.
- `child/tools/network-debugger/index.js` selects RPC, serve, or CLI mode.
- `child/tools/network-debugger/server.js` serves the UI, hosts `/ws`, validates the token, maps RPC methods, and exposes `/health` plus `/api/shutdown`.
- `child/tools/network-debugger/core.js` owns Node HTTP requests through `fetch`, header parsing, timeout handling, response body, response headers, and status metadata.
- `child/tools/network-debugger/ui/app.js` renders HTTP and WebSocket modes. HTTP calls the backend RPC API; external WebSocket testing runs in the browser UI.
- `child/tools/network-debugger/i18n/*.json` owns child-tool UI text. Update every locale file when adding visible strings.

Do not put HTTP transport behavior in Angular. Backend HTTP request behavior belongs in `core.js`; UI form state and external WebSocket interaction belong in `ui/app.js`.

## CLI Checks

Use these commands from the repo root:

```powershell
node child/tools/network-debugger/index.js --help
node child/tools/network-debugger/index.js status
node child/tools/network-debugger/index.js request --url http://127.0.0.1:8080/health --method GET --timeout-ms 5000
node child/tools/network-debugger/index.js request --url https://example.com/api --method POST --header "Content-Type: application/json" --body "{\"ping\":true}"
```

All non-help CLI commands write one JSON object to stdout. If the endpoint is not available, report that limitation and run code-level checks instead of inventing a response.

## Debugging Path

Follow the failing stage:

- No IP: verify Wi-Fi credentials, DHCP/static IP, antenna/power, and firmware network events.
- DNS failure: test by IP address, inspect DNS server, captive portal, and hostname spelling.
- TCP refused: verify server host/port, LAN reachability, firewall, and whether the MCU is connecting to the right network.
- TLS failure: check clock, CA certificate, hostname/SNI, certificate chain, TLS version, and memory pressure.
- Timeout: compare firmware timeout, tool timeout, server latency, payload size, and blocking work on the MCU.
- Wrong status/body: compare method, path, headers, content type, auth, JSON shape, and server-side validation.
- WebSocket silent: verify handshake URL, scheme, headers, ping/pong, close codes, and whether the MCU reconnects after Wi-Fi loss.
- UI is stuck: check backend readiness JSON on stdout, WebSocket token/origin, `/health`, Penpal `childReady`, and the host overlay error.

## Firmware Guidance

When designing MCU network firmware:

- Add serial logs for IP acquired, DNS start/result, connect start/result, request line, status code, body length, and parse result.
- Keep HTTP clients non-blocking where possible, or keep blocking calls bounded by explicit timeouts.
- Reuse a single JSON schema for generated firmware and tool test payloads.
- For WebSocket, send a small hello frame and a periodic heartbeat so silence is easy to diagnose.
- Report a test matrix in the answer: URL, method, headers, body sample, expected status/body, device log, and observed tool result.

## Modifying The Tool

When changing the Network Debugger tool itself:

- Put HTTP request, header parsing, response formatting, and timeout behavior in `core.js`.
- Put static serving, token, WebSocket RPC, `/health`, and shutdown behavior in `server.js`.
- Put CLI parsing and JSON output behavior in `cli.js`.
- Put UI state, HTTP form rendering, external WebSocket interaction, and logs in `ui/app.js`.
- Put host lifecycle, iframe, restart, and Penpal issues in the Angular child tool host or child tool process service.
- Keep the JSON contract stable unless the UI, CLI, server, and host are updated together.

## Verification

Choose checks that match the change:

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

For UI or Angular integration changes, also run:

```powershell
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

For real network behavior, verify against a reachable endpoint or MCU server and report URL, method, headers used, body, status, duration, and observed firmware log.
