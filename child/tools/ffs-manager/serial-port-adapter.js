'use strict';

const DEFAULT_OPEN_RETRY_ATTEMPTS = 6;
const PARK_DURATION_MS = 800;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data?.buffer) return new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || data.length || 0);
  return new Uint8Array(data || []);
}

function loadSerialPortClass() {
  const serialport = require('serialport');
  return serialport.SerialPort || serialport;
}

class NodeSerialPortAdapter {
  constructor(options = {}) {
    if (!options.path) {
      throw new Error('Serial port path is required');
    }

    this.path = options.path;
    this.extraOptions = options.extra || {};
    this.SerialPortClass = options.SerialPortClass || loadSerialPortClass();
    this.port = null;
    this.parkedPort = null;
    this.parkTimer = null;
    this.currentReadable = null;
    this.writable = null;
    this.rxQueue = [];
    this.rxPending = null;
    this.rxClosed = false;
    this.rxError = null;
    this.dataHandler = null;
    this.closeHandler = null;
    this.errorHandler = null;
  }

  get readable() {
    if (!this.port) return null;
    if (this.currentReadable) return this.currentReadable;
    return this.createReadable();
  }

  async open(options = {}) {
    if (this.port) {
      throw new Error('Serial port is already open');
    }

    if (this.parkedPort) {
      const parked = this.parkedPort;
      this.parkedPort = null;
      if (this.parkTimer) {
        clearTimeout(this.parkTimer);
        this.parkTimer = null;
      }
      await this.forceCloseRaw(parked);
    }

    const ctorOptions = {
      ...this.extraOptions,
      path: this.path,
      baudRate: options.baudRate || 115200,
      autoOpen: false
    };

    if (options.dataBits !== undefined) ctorOptions.dataBits = options.dataBits;
    if (options.stopBits !== undefined) ctorOptions.stopBits = options.stopBits;
    if (options.parity !== undefined) ctorOptions.parity = options.parity;
    if (options.flowControl === 'hardware') ctorOptions.rtscts = true;

    let openedPort = null;
    let lastError = null;

    for (let attempt = 0; attempt < DEFAULT_OPEN_RETRY_ATTEMPTS; attempt += 1) {
      const candidate = new this.SerialPortClass(ctorOptions);
      try {
        await new Promise((resolve, reject) => {
          candidate.open(error => (error ? reject(error) : resolve()));
        });
        openedPort = candidate;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        try {
          if (candidate?.isOpen) {
            await new Promise(resolve => candidate.close(() => resolve()));
          }
        } catch {
          // Ignore cleanup failures between retry attempts.
        }

        if (!this.isPortBusyError(error) || attempt === DEFAULT_OPEN_RETRY_ATTEMPTS - 1) {
          break;
        }

        await sleep(200 * Math.pow(2, attempt));
      }
    }

    if (!openedPort || lastError) {
      throw lastError || new Error(`Failed to open serial port ${this.path}`);
    }

    this.port = openedPort;
    this.attachStreams(openedPort);
  }

  async close() {
    const port = this.port;
    if (!port) return;

    this.port = null;
    this.detachListeners(port);
    this.rxClosed = true;
    const pending = this.rxPending;
    this.rxPending = null;
    if (pending) pending();
    this.currentReadable = null;
    this.writable = null;
    this.rxQueue = [];

    if (!port.isOpen) return;

    this.parkedPort = port;
    this.parkTimer = setTimeout(() => {
      const stale = this.parkedPort;
      this.parkedPort = null;
      this.parkTimer = null;
      if (stale) {
        this.forceCloseRaw(stale).catch(() => undefined);
      }
    }, PARK_DURATION_MS);
  }

  async dispose() {
    await this.close();
    if (this.parkTimer) {
      clearTimeout(this.parkTimer);
      this.parkTimer = null;
    }
    const parked = this.parkedPort;
    this.parkedPort = null;
    if (parked) await this.forceCloseRaw(parked);
  }

  async setSignals(signals = {}) {
    const port = this.port;
    if (!port) {
      throw new Error('Serial port is not open');
    }

    const payload = {};
    if (signals.dataTerminalReady !== undefined) payload.dtr = signals.dataTerminalReady;
    if (signals.requestToSend !== undefined) payload.rts = signals.requestToSend;
    if (signals.break !== undefined) payload.brk = signals.break;

    await new Promise((resolve, reject) => {
      port.set(payload, error => (error ? reject(error) : resolve()));
    });
  }

  getInfo() {
    return {};
  }

  attachStreams(port) {
    this.rxQueue = [];
    this.rxPending = null;
    this.rxClosed = false;
    this.rxError = null;
    this.currentReadable = null;

    this.dataHandler = data => {
      this.rxQueue.push(toUint8Array(data));
      const pending = this.rxPending;
      this.rxPending = null;
      if (pending) pending();
    };
    this.closeHandler = () => {
      this.rxClosed = true;
      const pending = this.rxPending;
      this.rxPending = null;
      if (pending) pending();
    };
    this.errorHandler = error => {
      this.rxError = error;
      const pending = this.rxPending;
      this.rxPending = null;
      if (pending) pending();
    };

    port.on('data', this.dataHandler);
    port.on('close', this.closeHandler);
    port.on('error', this.errorHandler);

    this.writable = new WritableStream({
      write: chunk => new Promise((resolve, reject) => {
        if (!this.port) {
          reject(new Error('Serial port is closed'));
          return;
        }
        this.port.write(Buffer.from(toUint8Array(chunk)), error => (error ? reject(error) : resolve()));
      }),
      close: () => Promise.resolve(),
      abort: () => Promise.resolve()
    });
  }

  createReadable() {
    let controller = null;
    let localClosed = false;

    const flush = () => {
      if (!controller || localClosed) return;
      while (this.rxQueue.length > 0) {
        try {
          controller.enqueue(this.rxQueue.shift());
        } catch {
          return;
        }
      }
      if (this.rxError) {
        try { controller.error(this.rxError); } catch {}
        this.rxError = null;
        localClosed = true;
      } else if (this.rxClosed) {
        try { controller.close(); } catch {}
        localClosed = true;
      }
    };

    const stream = new ReadableStream({
      start: ctrl => {
        controller = ctrl;
        flush();
      },
      pull: async () => {
        if (this.rxQueue.length > 0 || this.rxClosed || this.rxError) {
          flush();
          return;
        }
        await new Promise(resolve => {
          this.rxPending = resolve;
        });
        flush();
      },
      cancel: () => {
        localClosed = true;
        if (this.currentReadable === stream) {
          this.currentReadable = null;
        }
      }
    });

    this.currentReadable = stream;
    return stream;
  }

  detachListeners(port) {
    if (this.dataHandler) {
      try { port.off('data', this.dataHandler); } catch {}
      this.dataHandler = null;
    }
    if (this.closeHandler) {
      try { port.off('close', this.closeHandler); } catch {}
      this.closeHandler = null;
    }
    if (this.errorHandler) {
      try { port.off('error', this.errorHandler); } catch {}
      this.errorHandler = null;
    }
  }

  async forceCloseRaw(port) {
    await new Promise(resolve => {
      try {
        if (!port?.isOpen) {
          resolve();
          return;
        }
        port.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  isPortBusyError(error) {
    const code = String(error?.code || '').toUpperCase();
    const message = String(error?.message || error || '').toLowerCase();
    return (
      code === 'EACCES' ||
      code === 'EBUSY' ||
      code === 'ERR_ACCESS_DENIED' ||
      message.includes('access denied') ||
      message.includes('access is denied') ||
      message.includes('resource busy')
    );
  }
}

module.exports = {
  NodeSerialPortAdapter,
  sleep
};
