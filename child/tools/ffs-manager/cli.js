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
    'Aily FFS Manager CLI',
    '',
    'Usage:',
    '  node index.js rpc',
    '  node index.js serve [--host 127.0.0.1] [--port 0]',
    '  node index.js status',
    '  node index.js ports',
    '  node index.js info --port <path> [--baud 921600]',
    '  node index.js partitions --port <path> [--baud 921600]',
    '  node index.js read --port <path> --offset <number> --size <number> [--baud 921600]',
    '  node index.js erase --port <path> --offset <number> --size <number> [--baud 921600]',
    '  node index.js ble-status',
    '  node index.js ble-scan [--duration-ms 5000] [--service 180D]',
    '',
    'All non-help commands write one JSON object to stdout.'
  ].join('\n');
}

function writeCliJson(stdout, ok, command, data = {}, error = '') {
  stdout.write(`${JSON.stringify({ ok, command, data, error }, null, 2)}\n`);
}

function portOptions(options) {
  const port = options.port || options.portPath || options._[0];
  if (!port) throw new Error('Missing --port <path>');
  return {
    port,
    portPath: port,
    baudRate: numberOption(options.baudRate || options.baud, 921600, 115200)
  };
}

function partitionOptions(options) {
  const offset = Number(options.offset);
  const size = Number(options.size);
  if (!Number.isFinite(offset)) throw new Error('Missing --offset <number>');
  if (!Number.isFinite(size)) throw new Error('Missing --size <number>');
  return { offset, size, label: options.label || '' };
}

async function runCli(command, rawArgs, runtime = {}) {
  const stdout = runtime.stdout || process.stdout;
  const createCore = runtime.createCore;
  const version = runtime.version || require('./package.json').version;
  const options = parseCliArgs(rawArgs);
  let core = null;

  try {
    if (command === 'help') {
      stdout.write(`${helpText()}\n`);
      return 0;
    }
    if (command === 'version') {
      writeCliJson(stdout, true, command, { version });
      return 0;
    }
    if (typeof createCore !== 'function') {
      throw new Error('FFS core factory is not available');
    }

    core = createCore();
    let data;
    switch (command) {
      case 'status':
        data = core.status();
        break;
      case 'ports':
        data = { ports: await core.listSerialPorts() };
        break;
      case 'info':
        data = await core.readDeviceInfo(portOptions(options));
        break;
      case 'partitions':
        data = await core.readPartitionTable(portOptions(options));
        break;
      case 'read':
        data = await core.readPartitionImage({
          ...portOptions(options),
          partition: partitionOptions(options)
        });
        break;
      case 'erase':
        data = await core.erasePartition({
          ...portOptions(options),
          partition: partitionOptions(options)
        });
        break;
      case 'ble-status':
        data = await core.bleStatus();
        break;
      case 'ble-scan':
        data = await core.scanBle({
          durationMs: numberOption(options.durationMs || options.scanMs, 5000, 250),
          waitMs: numberOption(options.waitMs, 10000, 100),
          serviceUuids: stringListOption(options.service || options.services),
          allowDuplicates: boolOption(options.allowDuplicates, false)
        });
        break;
      default:
        throw new Error(`Unknown CLI command: ${command}. Run node index.js --help`);
    }

    writeCliJson(stdout, true, command, data);
    await core.cleanup();
    return 0;
  } catch (error) {
    if (core) await core.cleanup().catch(() => undefined);
    writeCliJson(stdout, false, command, {}, asError(error));
    return 1;
  }
}

module.exports = {
  requestedCommandFromArgs,
  parseCliArgs,
  runCli,
  helpText
};
