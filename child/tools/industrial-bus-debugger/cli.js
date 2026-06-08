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

    options[key] = value;
  }

  return options;
}

function boolOption(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function helpText() {
  return [
    'Aily Industrial Bus Debugger CLI',
    '',
    'Usage:',
    '  node index.js rpc',
    '  node index.js serve [--host 127.0.0.1] [--port 0]',
    '  node index.js status',
    '  node index.js can-send --frame-id 123 --payload "01 02"',
    '  node index.js can-parse --trace "123#DEADBEEF"',
    '  node index.js rs485-tx --payload "01 03 00 00 00 02" [--append-crc true]',
    '  node index.js modbus-build --protocol rtu --unit-id 1 --function 03 --address 0 --quantity 2',
    '  node index.js modbus-parse --protocol rtu --response-hex "01 03 04 00 2A 00 64 DA 3F"',
    '',
    'All CLI commands write one JSON object to stdout.'
  ].join('\n');
}

function writeCliJson(stdout, ok, command, data = {}, error = '') {
  stdout.write(`${JSON.stringify({ ok, command, data, error }, null, 2)}\n`);
}

function baseOptions(options) {
  return {
    ...options,
    canFrameId: options.frameId || options.canFrameId,
    canPayload: options.payload || options.canPayload,
    canFrameFormat: options.frameFormat || options.canFrameFormat,
    canFrameType: options.frameType || options.canFrameType,
    canFdEnabled: boolOption(options.canFd || options.canFdEnabled, false),
    canTraceInput: options.trace || options.canTraceInput,
    rs485Payload: options.payload || options.rs485Payload,
    rs485ReceiveInput: options.payload || options.rs485ReceiveInput,
    rs485AppendCrc: boolOption(options.appendCrc || options.rs485AppendCrc, true),
    modbusProtocol: options.protocol || options.modbusProtocol,
    modbusTransactionId: Number(options.transactionId || options.modbusTransactionId || 1),
    modbusUnitId: Number(options.unitId || options.modbusUnitId || 1),
    modbusFunction: options.function || options.functionCode || options.modbusFunction,
    modbusAddress: Number(options.address || options.modbusAddress || 0),
    modbusQuantity: Number(options.quantity || options.modbusQuantity || 2),
    modbusWriteValue: options.writeValue || options.modbusWriteValue,
    modbusResponseHex: options.responseHex || options.modbusResponseHex
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
          throw new Error('Industrial bus debugger core factory is not available');
        }
        core = createCore();
    }

    const mappedOptions = baseOptions(options);
    switch (command) {
      case 'status':
        data = core.status();
        break;
      case 'can-send':
        data = core.sendCanFrame(mappedOptions);
        break;
      case 'can-parse':
        data = core.parseCanTrace(mappedOptions);
        break;
      case 'rs485-tx':
        data = core.sendRs485Frame(mappedOptions);
        break;
      case 'rs485-rx':
        data = core.recordRs485Rx(mappedOptions);
        break;
      case 'modbus-build':
        data = core.buildModbusRequest(mappedOptions);
        break;
      case 'modbus-parse':
        data = core.parseModbusResponse(mappedOptions);
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
