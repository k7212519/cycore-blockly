#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { asError, createFfsManagerCore } = require('./core');
const { parseCliArgs, requestedCommandFromArgs, runCli } = require('./cli');
const { startFfsManagerServer } = require('./server');

const cliArgs = process.argv.slice(2);
const requestedCommand = requestedCommandFromArgs(cliArgs);

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResponse(id, ok, data = {}, error = '') {
  write({ id, ok, data, error });
}

function startRpcServer() {
  const sendEvent = (event, data = {}) => write({ event, data });
  let core;

  try {
    core = createFfsManagerCore({ sendEvent });
  } catch (error) {
    sendEvent('fatal', { message: asError(error) });
    process.exit(1);
    return;
  }

  let shuttingDown = false;
  const shutdownAndExit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void core.cleanup().finally(() => {
      setTimeout(() => process.exit(0), 10);
    });
  };

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  rl.on('line', line => {
    const text = line.trim();
    if (!text) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      sendEvent('error', { message: asError(error) });
      return;
    }

    void handleRpcMessage(core, message).then(() => {
      if (message.action === 'shutdown') {
        setTimeout(() => process.exit(0), 10);
      }
    });
  });

  process.on('SIGTERM', shutdownAndExit);
  process.on('SIGINT', shutdownAndExit);
  process.on('uncaughtException', error => {
    sendEvent('fatal', { message: asError(error) });
    process.exit(1);
  });
  process.on('unhandledRejection', error => {
    sendEvent('error', { message: asError(error) });
  });

  sendEvent('ready', {
    state: core.status(),
    pid: process.pid
  });
}

async function handleRpcMessage(core, message) {
  const id = message.id;
  try {
    const data = await core.executeAction(message);
    sendResponse(id, true, data);
  } catch (error) {
    sendResponse(id, false, {}, asError(error));
  }
}

async function startServeMode(rawArgs) {
  const options = parseCliArgs(rawArgs);
  let serverHandle;
  let shuttingDown = false;

  const shutdownAndExit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const stop = serverHandle?.stop ? serverHandle.stop() : Promise.resolve();
    void stop.finally(() => {
      setTimeout(() => process.exit(0), 10);
    });
  };

  process.on('SIGTERM', shutdownAndExit);
  process.on('SIGINT', shutdownAndExit);
  process.on('uncaughtException', error => {
    write({ event: 'fatal', data: { message: asError(error) } });
    process.exit(1);
  });
  process.on('unhandledRejection', error => {
    write({ event: 'error', data: { message: asError(error) } });
  });

  try {
    serverHandle = await startFfsManagerServer({
      host: options.host || '127.0.0.1',
      port: options.port === undefined ? 0 : Number(options.port),
      token: options.token
    });

    write({
      event: 'ready',
      data: {
        mode: 'serve',
        url: serverHandle.url,
        origin: serverHandle.origin,
        wsUrl: serverHandle.wsUrl,
        shutdownUrl: serverHandle.shutdownUrl,
        port: serverHandle.port,
        pid: process.pid
      }
    });
  } catch (error) {
    write({ event: 'fatal', data: { message: asError(error) } });
    process.exit(1);
  }
}

if (requestedCommand === 'rpc' || requestedCommand === 'server') {
  startRpcServer();
} else if (requestedCommand === 'serve') {
  void startServeMode(cliArgs.slice(1));
} else {
  void runCli(requestedCommand, cliArgs.slice(1), {
    createCore: () => createFfsManagerCore(),
    stdout: process.stdout
  }).then(code => process.exit(code));
}
