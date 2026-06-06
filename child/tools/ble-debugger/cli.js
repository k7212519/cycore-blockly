'use strict';

const { asError } = require('./core');

function requestedCommandFromArgs(args) {
  const first = args[0];
  if (!first) return 'rpc';
  if (first === '-h' || first === '--help') return 'help';
  if (first === '-v' || first === '--version') return 'version';
  return first;
}

function parseCliArgs(args) {
  const options = { _: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const rawKey = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    let value = eqIndex >= 0 ? arg.slice(eqIndex + 1) : true;

    if (eqIndex < 0 && args[index + 1] && !args[index + 1].startsWith('--')) {
      value = args[index + 1];
      index += 1;
    }

    if (options[key] === undefined) {
      options[key] = value;
    } else if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = [options[key], value];
    }
  }

  return options;
}

function boolOption(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function numberOption(value, defaultValue, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, parsed);
}

function stringListOption(value) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap(item => String(item).split(/[\s,;]+/))
    .map(item => item.trim())
    .filter(Boolean);
}

function helpText() {
  return [
    'Aily BLE Debugger CLI',
    '',
    'Usage:',
    '  node index.js rpc',
    '  node index.js serve [--host 127.0.0.1] [--port 0]',
    '  node index.js status',
    '  node index.js scan [--duration-ms 5000] [--service 180D] [--allow-duplicates false]',
    '  node index.js gatt --id <device-id> [--scan-ms 10000]',
    '  node index.js read --id <device-id> --service <uuid> --characteristic <uuid>',
    '  node index.js write --id <device-id> --service <uuid> --characteristic <uuid> --payload "01 02" [--mode hex|ascii] [--without-response]',
    '  node index.js notify --id <device-id> --service <uuid> --characteristic <uuid> [--duration-ms 10000]',
    '',
    'Device selectors:',
    '  --id <id>              Match noble id, UUID, or address',
    '  --address <address>    Match BLE address',
    '  --name <name>          Match exact local name',
    '  --name-contains <text> Match partial local name',
    '  --scan-service <uuid>  Filter advertised service while locating a device',
    '',
    'All CLI commands write one JSON object to stdout. Use rpc mode for the UI JSON-lines protocol.'
  ].join('\n');
}

function writeCliJson(stdout, ok, command, data = {}, error = '') {
  stdout.write(`${JSON.stringify({ ok, command, data, error }, null, 2)}\n`);
}

function deviceSelectorOptions(options) {
  return {
    id: options.id || options.device,
    address: options.address,
    name: options.name,
    nameContains: options.nameContains || options.contains,
    waitMs: numberOption(options.waitMs, 10000, 100),
    scanMs: numberOption(options.scanMs || options.durationMs, 10000, 250),
    scanServiceUuids: stringListOption(options.scanService || options.serviceFilter || options.advertisedService),
    allowDuplicates: boolOption(options.allowDuplicates, true)
  };
}

function characteristicOptions(options) {
  const serviceUuid = options.service || options.serviceUuid;
  const characteristicUuid = options.characteristic || options.characteristicUuid || options.char;
  if (!serviceUuid) throw new Error('Missing --service <uuid>');
  if (!characteristicUuid) throw new Error('Missing --characteristic <uuid>');
  return { serviceUuid, characteristicUuid };
}

function commandOptions(options) {
  return {
    ...deviceSelectorOptions(options),
    ...characteristicOptions(options)
  };
}

async function runCli(command, rawArgs, runtime = {}) {
  const stdout = runtime.stdout || process.stdout;
  const createCore = runtime.createCore;
  const version = runtime.version || require('./package.json').version;
  const options = parseCliArgs(rawArgs);
  let core = null;

  try {
    let data;
    switch (command) {
      case 'help':
        stdout.write(`${helpText()}\n`);
        return 0;
      case 'version':
        writeCliJson(stdout, true, command, { version });
        return 0;
      default:
        if (typeof createCore !== 'function') {
          throw new Error('BLE core factory is not available');
        }
        core = createCore();
    }

    switch (command) {
      case 'status':
        data = core.status();
        break;
      case 'scan':
        data = await core.scanDevices({
          durationMs: numberOption(options.durationMs || options.scanMs, 5000, 250),
          waitMs: numberOption(options.waitMs, 10000, 100),
          serviceUuids: stringListOption(options.service || options.services),
          allowDuplicates: boolOption(options.allowDuplicates, false)
        });
        break;
      case 'connect':
      case 'gatt':
        data = await core.withConnectedDevice(deviceSelectorOptions(options), async connection => ({
          services: connection.services,
          scanElapsedMs: connection.scanElapsedMs
        }));
        break;
      case 'read':
        data = await core.readBySelector(commandOptions(options));
        break;
      case 'write':
        if (options.payload === undefined) throw new Error('Missing --payload <value>');
        data = await core.writeBySelector({
          ...commandOptions(options),
          payload: options.payload,
          mode: options.mode || 'hex',
          withoutResponse: boolOption(options.withoutResponse, false)
        });
        break;
      case 'notify':
        data = await core.notifyBySelector({
          ...commandOptions(options),
          durationMs: numberOption(options.durationMs, 10000, 250)
        });
        break;
      default:
        throw new Error(`Unknown CLI command: ${command}. Run node index.js --help`);
    }

    writeCliJson(stdout, true, command, data);
    await core.cleanup();
    return 0;
  } catch (error) {
    if (core) await core.cleanup();
    writeCliJson(stdout, false, command, {}, asError(error));
    return 1;
  }
}

module.exports = {
  requestedCommandFromArgs,
  runCli,
  helpText,
  parseCliArgs
};
