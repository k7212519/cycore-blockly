'use strict';

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function createMqttDebuggerCore() {
  function status() {
    return {
      state: 'ready',
      pid: process.pid
    };
  }

  async function executeAction(message = {}) {
    const action = message.action || message.method;

    switch (action) {
      case 'status':
        return status();
      case 'shutdown':
        return { closing: true };
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async function shutdown() {
    return { closing: true };
  }

  async function cleanup() {
    return { ok: true };
  }

  return {
    status,
    executeAction,
    shutdown,
    cleanup
  };
}

module.exports = {
  asError,
  createMqttDebuggerCore
};
