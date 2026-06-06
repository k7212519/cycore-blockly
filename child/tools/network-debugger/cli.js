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

function helpText() {
  return [
    'Aily Network Debugger CLI',
    '',
    'Usage:',
    '  node index.js rpc',
    '  node index.js serve [--host 127.0.0.1] [--port 0]',
    '  node index.js status',
    '  node index.js request --url <http-url> [--method GET] [--header "Name: value"] [--body "..."] [--timeout-ms 10000]',
    '',
    'All CLI commands write one JSON object to stdout. Use rpc mode for the UI JSON-lines protocol.'
  ].join('\n');
}

function writeCliJson(stdout, ok, command, data = {}, error = '') {
  stdout.write(`${JSON.stringify({ ok, command, data, error }, null, 2)}\n`);
}

function headerTextFromOptions(options) {
  const values = [];
  if (options.headersText) values.push(String(options.headersText));
  if (options.header) {
    const headers = Array.isArray(options.header) ? options.header : [options.header];
    values.push(...headers.map(String));
  }
  return values.join('\n');
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
          throw new Error('Network debugger core factory is not available');
        }
        core = createCore();
    }

    switch (command) {
      case 'status':
        data = core.status();
        break;
      case 'request':
        data = await core.sendHttpRequest({
          url: options.url || options._[0],
          method: options.method || 'GET',
          headersText: headerTextFromOptions(options),
          body: options.body,
          timeoutMs: options.timeoutMs || options.timeout
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
