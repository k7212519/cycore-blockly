'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { NodeSerialPortAdapter, sleep } = require('./serial-port-adapter');
const { resolveDesiredBaud } = require('./usb-bridge');

const DEFAULT_PARTITION_TABLE_OFFSET = 0x8000;
const PARTITION_TABLE_SIZE = 0xc00;
const PARTITION_ENTRY_SIZE = 32;
const PARTITION_MAGIC = 0x50aa;
const PARTITION_ALIGNMENT = 0x1000;
const PARTITION_TABLE_PROBE_OFFSETS = [
  0x8000, 0x9000, 0xa000, 0xc000, 0xd000, 0xe000, 0x10000
];

const FLASH_READ_MAX_CHUNK = 0x10000;
const FLASH_READ_MIN_CHUNK = 0x1000;

const FLASH_MANUFACTURERS = {
  '01': 'Spansion / Cypress',
  '0b': 'XMC',
  '1c': 'EON',
  '20': 'Micron',
  '68': 'Boya',
  '85': 'Puya',
  '9d': 'ISSI',
  'a1': 'Fudan Micro',
  'bf': 'Microchip / SST',
  'c2': 'Macronix',
  'c8': 'GigaDevice',
  'ef': 'Winbond'
};

let esptoolPromise = null;
let nobleInstance = null;

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function toHex(value, minLength = 0) {
  return `0x${Number(value || 0).toString(16).toUpperCase().padStart(minLength, '0')}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function readAscii(bytes) {
  let text = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }
  return text.trim();
}

function bufferToHex(buffer) {
  return Array.from(buffer || [])
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

function normalizeUuid(uuid) {
  return String(uuid || '').trim().toLowerCase().replace(/^0x/, '').replace(/-/g, '');
}

function displayUuid(uuid) {
  const normalized = normalizeUuid(uuid);
  if (normalized.length === 4) return `0x${normalized.toUpperCase()}`;
  return normalized || '-';
}

function normalizeUuidList(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : String(value).split(/[\s,;]+/);
  return values.map(normalizeUuid).filter(Boolean);
}

function numberOption(value, defaultValue, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, parsed);
}

async function loadEsptool() {
  if (!esptoolPromise) {
    esptoolPromise = (async () => {
      const packagePath = require.resolve('esptool-js/package.json');
      const bundlePath = path.join(path.dirname(packagePath), 'bundle.js');
      return await import(pathToFileURL(bundlePath).href);
    })();
  }
  return await esptoolPromise;
}

function loadSerialPortClass() {
  const serialport = require('serialport');
  return serialport.SerialPort || serialport;
}

function loadNoble() {
  if (!nobleInstance) {
    nobleInstance = require('@abandonware/noble');
  }
  return nobleInstance;
}

class EspSession {
  constructor(options = {}) {
    this.sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : null;
    this.port = null;
    this.transport = null;
    this.loader = null;
    this.chipInfo = null;
    this.currentPortPath = null;
    this.currentBaud = 0;
    this.currentRequestedBaud = 0;
    this.operationQueue = Promise.resolve();
  }

  get isConnected() {
    return Boolean(this.loader && this.transport);
  }

  get chip() {
    return this.chipInfo;
  }

  get portPath() {
    return this.currentPortPath;
  }

  get baudRate() {
    return this.currentBaud;
  }

  get requestedBaudRate() {
    return this.currentRequestedBaud;
  }

  async connect(options = {}) {
    const portPath = options.portPath || options.port;
    const requestedBaud = Number(options.baudRate || options.baud || 921600);
    if (!portPath) {
      throw new Error('Serial port path is required');
    }

    if (
      this.isConnected &&
      this.currentPortPath === portPath &&
      (this.currentRequestedBaud === requestedBaud || this.currentBaud === requestedBaud)
    ) {
      return this.chipInfo;
    }

    if (this.isConnected) {
      await this.disconnect();
    }

    const { ESPLoader, Transport } = await loadEsptool();
    const port = new NodeSerialPortAdapter({ path: portPath });
    const resolved = await resolveDesiredBaud(portPath, requestedBaud);
    if (resolved.capped) {
      this.emit('baudResolved', { ...resolved, port: portPath });
    }

    const transport = new Transport(port, false);
    const loader = new ESPLoader({
      transport,
      baudrate: resolved.baud,
      debugLogging: false,
      terminal: this.buildTerminal()
    });

    try {
      const chipName = await loader.main('default_reset');
      const mac = await this.tryReadMac(loader);
      const flashSize = await this.tryReadFlashSize(loader);
      const description = await this.tryReadChipDescription(loader);
      const features = await this.tryReadChipFeatures(loader);
      const crystalFreq = await this.tryReadCrystalFreq(loader);

      this.port = port;
      this.transport = transport;
      this.loader = loader;
      this.currentPortPath = portPath;
      this.currentBaud = resolved.baud;
      this.currentRequestedBaud = requestedBaud;
      this.chipInfo = { chipName, mac, flashSize, description, features, crystalFreq };
      return this.chipInfo;
    } catch (error) {
      try { await transport.disconnect(); } catch {}
      try { await port.dispose(); } catch {}
      throw new Error(`ESP connect failed: ${asError(error)}`);
    }
  }

  async disconnect(hardReset = true) {
    const loader = this.loader;
    const transport = this.transport;
    const port = this.port;

    this.loader = null;
    this.transport = null;
    this.port = null;
    this.chipInfo = null;
    this.currentPortPath = null;
    this.currentBaud = 0;
    this.currentRequestedBaud = 0;
    this.operationQueue = Promise.resolve();

    if (port && hardReset) {
      try {
        await this.pulseHardReset(port);
      } catch (error) {
        this.emit('log', { level: 'warn', message: `DTR/RTS hard reset failed: ${asError(error)}` });
      }
    }

    if (transport) {
      try { await transport.disconnect(); } catch (error) {
        this.emit('log', { level: 'warn', message: `Transport disconnect failed: ${asError(error)}` });
      }
    }

    if (port) {
      try { await port.dispose(); } catch (error) {
        this.emit('log', { level: 'warn', message: `Serial port dispose failed: ${asError(error)}` });
      }
      await sleep(400);
    }

    return { connected: false };
  }

  async readFlash(offset, length, onProgress) {
    if (length <= 0) return new Uint8Array(0);
    return await this.runExclusive(async loader => {
      const chunkSize = Math.max(FLASH_READ_MIN_CHUNK, Math.min(FLASH_READ_MAX_CHUNK, length));
      const buffers = [];
      let received = 0;
      while (received < length) {
        const remaining = length - received;
        const currentChunkSize = Math.min(chunkSize, remaining);
        const chunkOffset = offset + received;
        const chunkBase = received;
        const chunk = await loader.readFlash(chunkOffset, currentChunkSize, (_packet, packetReceived) => {
          const overall = chunkBase + Math.min(packetReceived, currentChunkSize);
          onProgress?.(overall, length);
        });
        buffers.push(Buffer.from(chunk));
        received += chunk.length;
      }
      return new Uint8Array(Buffer.concat(buffers, received));
    });
  }

  async erasePartition(offset, size) {
    if (size <= 0) return;
    await this.runExclusive(async loader => {
      const payload = new Uint8Array(8);
      const view = new DataView(payload.buffer);
      view.setUint32(0, offset, true);
      view.setUint32(4, size, true);
      const timeout = Math.max(loader.timeoutPerMb(loader.ERASE_REGION_TIMEOUT_PER_MB, size), loader.DEFAULT_TIMEOUT);
      await loader.checkCommand('erase region', loader.ESP_ERASE_REGION, payload, 0, timeout);
    });
  }

  async writePartitionImage(offset, data, onProgress) {
    await this.runExclusive(async loader => {
      await loader.writeFlash({
        fileArray: [{ data: new Uint8Array(data), address: offset }],
        flashSize: 'keep',
        flashMode: 'keep',
        flashFreq: 'keep',
        eraseAll: false,
        compress: true,
        reportProgress: (_index, written, total) => {
          onProgress?.(written, total);
        }
      });
    });
  }

  async pulseHardReset(port) {
    if (typeof port?.setSignals !== 'function') return;
    await port.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(100);
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(50);
  }

  runExclusive(fn) {
    const next = this.operationQueue.then(async () => {
      const loader = this.loader;
      if (!loader) {
        throw new Error('ESP device is not connected');
      }
      return await fn(loader);
    });
    this.operationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  buildTerminal() {
    return {
      clean: () => undefined,
      writeLine: data => this.emit('log', { level: 'debug', message: String(data || '') }),
      write: data => this.emit('log', { level: 'debug', message: String(data || '') })
    };
  }

  async tryReadMac(loader) {
    try {
      const mac = await loader.chip?.readMac?.(loader);
      return typeof mac === 'string' ? mac : undefined;
    } catch {
      return undefined;
    }
  }

  async tryReadFlashSize(loader) {
    try {
      const id = await loader.readFlashId();
      const sizeId = (id >> 16) & 0xff;
      return loader.DETECTED_FLASH_SIZES[sizeId];
    } catch {
      return undefined;
    }
  }

  async tryReadChipDescription(loader) {
    try {
      const desc = await loader.chip?.getChipDescription?.(loader);
      return typeof desc === 'string' ? desc : undefined;
    } catch {
      return undefined;
    }
  }

  async tryReadChipFeatures(loader) {
    try {
      const features = await loader.chip?.getChipFeatures?.(loader);
      return Array.isArray(features) ? features : undefined;
    } catch {
      return undefined;
    }
  }

  async tryReadCrystalFreq(loader) {
    try {
      const freq = await loader.chip?.getCrystalFreq?.(loader);
      return typeof freq === 'number' && Number.isFinite(freq) ? freq : undefined;
    } catch {
      return undefined;
    }
  }

  emit(event, data = {}) {
    if (this.sendEvent) this.sendEvent(event, data);
  }
}

function createFfsManagerCore(options = {}) {
  const sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : null;
  const espSession = new EspSession({ sendEvent });

  const emit = (event, data = {}) => {
    if (sendEvent) sendEvent(event, data);
  };

  function status() {
    return {
      serial: {
        connected: espSession.isConnected,
        portPath: espSession.portPath,
        baudRate: espSession.baudRate,
        requestedBaudRate: espSession.requestedBaudRate
      },
      ble: {
        loaded: !!nobleInstance,
        state: nobleInstance?.state || 'not-loaded'
      }
    };
  }

  async function listSerialPorts() {
    const SerialPort = loadSerialPortClass();
    const ports = await SerialPort.list();
    return ports.map(port => ({
      path: port.path,
      name: port.friendlyName || port.path,
      manufacturer: port.manufacturer || '',
      serialNumber: port.serialNumber || '',
      vendorId: port.vendorId || '',
      productId: port.productId || '',
      pnpId: port.pnpId || '',
      locationId: port.locationId || ''
    }));
  }

  async function ensureSession(portPath, baudRate) {
    if (
      espSession.isConnected &&
      espSession.portPath === portPath &&
      (espSession.requestedBaudRate === baudRate || espSession.baudRate === baudRate)
    ) {
      return;
    }
    await espSession.connect({ portPath, baudRate });
  }

  async function readDeviceInfo(options = {}) {
    const port = options.portPath || options.port;
    const baudRate = Number(options.baudRate || options.baud || 921600);
    await ensureSession(port, baudRate);
    const chip = espSession.chip;
    let manufacturerId = '';
    let deviceId = '';
    let flashSize = chip?.flashSize || '';

    try {
      const flashIdRaw = await readFlashIdRaw();
      manufacturerId = (flashIdRaw & 0xff).toString(16).padStart(2, '0');
      deviceId = ((flashIdRaw >> 8) & 0xffff).toString(16).padStart(4, '0');
      if (!flashSize) {
        const sizeId = (flashIdRaw >> 16) & 0xff;
        flashSize = String(sizeId);
      }
    } catch (error) {
      emit('log', { level: 'warn', message: `Read flash id failed: ${asError(error)}` });
    }

    return {
      chip: chip?.description || chip?.chipName || 'Unknown',
      mac: chip?.mac || '',
      features: chip?.features?.length ? chip.features.join(', ') : '',
      crystal: typeof chip?.crystalFreq === 'number' && chip.crystalFreq > 0 ? `${chip.crystalFreq} MHz` : '',
      flashId: manufacturerId && deviceId ? `${manufacturerId}${deviceId}` : '',
      flashManufacturerId: manufacturerId,
      flashManufacturer: FLASH_MANUFACTURERS[manufacturerId] || '',
      flashDeviceId: deviceId,
      flashSize,
      rawOutput: `Chip: ${chip?.description || chip?.chipName}\nMAC: ${chip?.mac}\nFeatures: ${chip?.features?.join(', ') || ''}\nCrystal: ${chip?.crystalFreq ?? ''}\nFlash size: ${flashSize}\nFlash ID: ${manufacturerId}${deviceId}`
    };
  }

  async function readPartitionTable(options = {}) {
    const port = options.portPath || options.port;
    const baudRate = Number(options.baudRate || options.baud || 921600);
    await ensureSession(port, baudRate);
    const tableOffset = await detectPartitionTableOffset();
    const bytes = await espSession.readFlash(tableOffset, PARTITION_TABLE_SIZE);
    return {
      tableOffset,
      tableOffsetHex: toHex(tableOffset),
      partitions: parsePartitionTable(bytes)
    };
  }

  async function readPartitionImage(options = {}) {
    const port = options.portPath || options.port;
    const baudRate = Number(options.baudRate || options.baud || 921600);
    const partition = normalizePartitionInput(options.partition || options);
    const operationId = options.operationId || `read-${Date.now()}`;
    await ensureSession(port, baudRate);
    const image = await espSession.readFlash(partition.offset, partition.size, (done, total) => {
      emit('progress', { operationId, kind: 'read', done, total, partition });
    });
    emit('progress', { operationId, kind: 'read', done: image.length, total: partition.size, partition });
    return {
      operationId,
      partition,
      byteLength: image.length,
      base64: Buffer.from(image).toString('base64')
    };
  }

  async function writePartitionImage(options = {}) {
    const port = options.portPath || options.port;
    const baudRate = Number(options.baudRate || options.baud || 921600);
    const partition = normalizePartitionInput(options.partition || options);
    const data = Buffer.from(String(options.base64 || ''), 'base64');
    const operationId = options.operationId || `write-${Date.now()}`;

    if (data.length !== partition.size) {
      throw new Error(`Image size must equal partition size: ${formatBytes(partition.size)}`);
    }

    await ensureSession(port, baudRate);
    await espSession.writePartitionImage(partition.offset, data, (done, total) => {
      emit('progress', { operationId, kind: 'write', done, total, partition });
    });
    emit('progress', { operationId, kind: 'write', done: data.length, total: data.length, partition });
    return { operationId, written: data.length, partition };
  }

  async function erasePartition(options = {}) {
    const port = options.portPath || options.port;
    const baudRate = Number(options.baudRate || options.baud || 921600);
    const partition = normalizePartitionInput(options.partition || options);
    await ensureSession(port, baudRate);
    await espSession.erasePartition(partition.offset, partition.size);
    return { erased: true, partition };
  }

  async function release(options = {}) {
    return await espSession.disconnect(options.hardReset !== false);
  }

  async function waitForPortReady(options = {}) {
    const portPath = options.portPath || options.port;
    const timeoutMs = numberOption(options.timeoutMs, 3000, 250);
    if (!portPath) throw new Error('Serial port path is required');

    const SerialPort = loadSerialPortClass();
    const start = Date.now();
    let lastError = '';
    while (Date.now() - start < timeoutMs) {
      const ports = await SerialPort.list().catch(error => {
        lastError = asError(error);
        return [];
      });
      const visible = ports.some(port => port.path === portPath);
      if (visible) {
        const adapter = new NodeSerialPortAdapter({ path: portPath });
        try {
          await adapter.open({ baudRate: 115200 });
          await adapter.dispose();
          await sleep(200);
          return { ready: true, elapsedMs: Date.now() - start };
        } catch (error) {
          lastError = asError(error);
          try { await adapter.dispose(); } catch {}
        }
      }
      await sleep(200);
    }

    return { ready: false, elapsedMs: Date.now() - start, error: lastError || 'Port was not visible' };
  }

  async function readFlashIdRaw() {
    const loader = espSession.loader;
    if (!loader) throw new Error('ESP device is not connected');
    return await loader.readFlashId();
  }

  async function detectPartitionTableOffset() {
    for (const candidate of PARTITION_TABLE_PROBE_OFFSETS) {
      try {
        const entry = await espSession.readFlash(candidate, PARTITION_ENTRY_SIZE);
        if (hasPlausiblePartitionEntry(entry)) return candidate;
      } catch (error) {
        emit('log', { level: 'warn', message: `Partition table probe ${toHex(candidate)} failed: ${asError(error)}` });
      }
    }
    return DEFAULT_PARTITION_TABLE_OFFSET;
  }

  function hasPlausiblePartitionEntry(bytes) {
    if (bytes.length < PARTITION_ENTRY_SIZE) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0, true) !== PARTITION_MAGIC) return false;
    const type = view.getUint8(2);
    const offset = view.getUint32(4, true);
    const size = view.getUint32(8, true);
    if (type === 0xff) return false;
    if (offset < PARTITION_ALIGNMENT || size < PARTITION_ALIGNMENT) return false;
    return offset % PARTITION_ALIGNMENT === 0 && size % PARTITION_ALIGNMENT === 0;
  }

  function parsePartitionTable(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const partitions = [];

    for (let offset = 0; offset + PARTITION_ENTRY_SIZE <= bytes.length; offset += PARTITION_ENTRY_SIZE) {
      const magic = view.getUint16(offset, true);
      if (magic === 0xffff || magic === 0x0000) break;
      if (magic !== PARTITION_MAGIC) continue;

      const type = view.getUint8(offset + 2);
      const subtype = view.getUint8(offset + 3);
      const partitionOffset = view.getUint32(offset + 4, true);
      const size = view.getUint32(offset + 8, true);
      const label = readAscii(bytes.subarray(offset + 12, offset + 28));
      const flags = view.getUint32(offset + 28, true);
      const typeName = getPartitionTypeName(type);
      const subtypeName = getPartitionSubtypeName(type, subtype);

      partitions.push({
        index: partitions.length,
        label,
        type,
        subtype,
        typeName,
        subtypeName,
        offset: partitionOffset,
        size,
        flags,
        offsetHex: toHex(partitionOffset),
        sizeHex: toHex(size),
        sizeText: formatBytes(size),
        filesystemType: detectFilesystemType(label, type, subtype)
      });
    }

    return partitions;
  }

  function getPartitionTypeName(type) {
    if (type === 0x00) return 'app';
    if (type === 0x01) return 'data';
    return toHex(type, 2);
  }

  function getPartitionSubtypeName(type, subtype) {
    if (type === 0x00) {
      if (subtype === 0x00) return 'factory';
      if (subtype === 0x20) return 'test';
      if (subtype >= 0x10 && subtype <= 0x1f) return `ota_${subtype - 0x10}`;
    }

    if (type === 0x01) {
      const dataSubtypes = {
        0x00: 'ota',
        0x01: 'phy',
        0x02: 'nvs',
        0x03: 'coredump',
        0x04: 'nvs_keys',
        0x05: 'efuse',
        0x80: 'esphttpd',
        0x81: 'fatfs',
        0x82: 'spiffs',
        0x83: 'littlefs'
      };
      return dataSubtypes[subtype] || toHex(subtype, 2);
    }

    return toHex(subtype, 2);
  }

  function detectFilesystemType(label, type, subtype) {
    if (type !== 0x01) return null;
    if (subtype === 0x82) return 'spiffs';
    if (subtype === 0x83) return 'littlefs';
    if (subtype === 0x81) return 'fatfs';
    const normalized = String(label || '').toLowerCase();
    if (normalized.includes('littlefs') || normalized.includes('little_fs')) return 'littlefs';
    if (normalized.includes('spiffs') || normalized.includes('spiflash')) return 'spiffs';
    if (normalized.includes('fatfs') || normalized === 'ffat' || normalized.includes('vfs')) return 'fatfs';
    return null;
  }

  function normalizePartitionInput(input = {}) {
    const offset = Number(input.offset);
    const size = Number(input.size);
    if (!Number.isFinite(offset) || offset < 0) throw new Error('Partition offset is required');
    if (!Number.isFinite(size) || size <= 0) throw new Error('Partition size is required');
    return {
      ...input,
      offset,
      size,
      label: input.label || '',
      offsetHex: input.offsetHex || toHex(offset),
      sizeHex: input.sizeHex || toHex(size),
      sizeText: input.sizeText || formatBytes(size),
      filesystemType: input.filesystemType || null
    };
  }

  function serializeBlePeripheral(peripheral) {
    const advertisement = peripheral.advertisement || {};
    return {
      id: peripheral.id || peripheral.uuid || peripheral.address,
      uuid: peripheral.uuid || '',
      address: peripheral.address || '',
      addressType: peripheral.addressType || '',
      name: advertisement.localName || peripheral.name || 'Unknown device',
      localName: advertisement.localName || '',
      rssi: typeof peripheral.rssi === 'number' ? peripheral.rssi : null,
      connectable: peripheral.connectable !== false,
      serviceUuids: Array.isArray(advertisement.serviceUuids) ? advertisement.serviceUuids.map(displayUuid) : [],
      manufacturerData: advertisement.manufacturerData ? bufferToHex(advertisement.manufacturerData) : '',
      txPowerLevel: typeof advertisement.txPowerLevel === 'number' ? advertisement.txPowerLevel : null
    };
  }

  async function waitForBlePoweredOn(noble, timeoutMs = 10000) {
    if (noble.state === 'poweredOn') return noble.state;
    if (['unsupported', 'unauthorized', 'poweredOff'].includes(noble.state)) {
      throw new Error(`Bluetooth adapter is ${noble.state}`);
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        noble.removeListener('stateChange', onStateChange);
        reject(new Error(`Bluetooth adapter did not become poweredOn within ${timeoutMs} ms; current state is ${noble.state || 'unknown'}`));
      }, timeoutMs);

      const onStateChange = state => {
        if (state === 'poweredOn') {
          clearTimeout(timer);
          noble.removeListener('stateChange', onStateChange);
          resolve(state);
          return;
        }
        if (['unsupported', 'unauthorized', 'poweredOff'].includes(state)) {
          clearTimeout(timer);
          noble.removeListener('stateChange', onStateChange);
          reject(new Error(`Bluetooth adapter is ${state}`));
        }
      };

      noble.on('stateChange', onStateChange);
    });
  }

function stopBleScan(noble) {
  return Promise.race([new Promise(resolve => {
    try {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const maybePromise = noble.stopScanningAsync ? noble.stopScanningAsync() : noble.stopScanning(done);
      if (maybePromise?.then) maybePromise.then(done, done);
      else setTimeout(done, 50);
    } catch {
      resolve();
    }
  }), sleep(500).then(() => undefined)]);
}

  async function bleStatus() {
    const noble = loadNoble();
    return {
      state: noble.state || 'unknown',
      loaded: true
    };
  }

  async function scanBle(options = {}) {
    const noble = loadNoble();
    const durationMs = numberOption(options.durationMs, 5000, 250);
    const waitMs = numberOption(options.waitMs, 10000, 100);
    const serviceUuids = normalizeUuidList(options.serviceUuids || options.service || options.services);
    const allowDuplicates = options.allowDuplicates === true;
    const devices = new Map();

    await waitForBlePoweredOn(noble, waitMs);

    const onDiscover = peripheral => {
      const device = serializeBlePeripheral(peripheral);
      if (!device.id) return;
      devices.set(device.id, device);
      emit('bleDevice', device);
    };

    noble.on('discover', onDiscover);
    try {
      if (noble.startScanningAsync) {
        await noble.startScanningAsync(serviceUuids, allowDuplicates);
      } else {
        await new Promise((resolve, reject) => {
          noble.startScanning(serviceUuids, allowDuplicates, error => (error ? reject(error) : resolve()));
        });
      }
      emit('bleScanStart', { serviceUuids, allowDuplicates });
      await sleep(durationMs);
    } finally {
      noble.removeListener('discover', onDiscover);
      await stopBleScan(noble);
      emit('bleScanStop', {});
    }

    return {
      state: noble.state || 'unknown',
      durationMs,
      serviceUuids,
      devices: Array.from(devices.values()).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
    };
  }

  async function cleanup() {
    try { await release({ hardReset: true }); } catch {}
    if (nobleInstance) {
      try { await stopBleScan(nobleInstance); } catch {}
    }
    return { closing: true };
  }

  async function executeAction(message = {}) {
    switch (message.action) {
      case 'status':
        return status();
      case 'serial.list':
      case 'ports':
        return { ports: await listSerialPorts() };
      case 'device.readInfo':
      case 'readDeviceInfo':
        return await readDeviceInfo(message);
      case 'partition.readTable':
      case 'readPartitionTable':
        return await readPartitionTable(message);
      case 'partition.readImage':
      case 'readPartitionImage':
        return await readPartitionImage(message);
      case 'partition.writeImage':
      case 'writePartitionImage':
        return await writePartitionImage(message);
      case 'partition.erase':
      case 'erasePartition':
        return await erasePartition(message);
      case 'session.release':
      case 'release':
        return await release(message);
      case 'port.waitReady':
      case 'waitForPortReady':
        return await waitForPortReady(message);
      case 'ble.status':
        return await bleStatus();
      case 'ble.scan':
        return await scanBle(message);
      case 'shutdown':
        return await cleanup();
      default:
        throw new Error(`Unknown action: ${message.action}`);
    }
  }

  return {
    status,
    listSerialPorts,
    readDeviceInfo,
    readPartitionTable,
    readPartitionImage,
    writePartitionImage,
    erasePartition,
    release,
    waitForPortReady,
    bleStatus,
    scanBle,
    cleanup,
    executeAction,
    parsePartitionTable
  };
}

module.exports = {
  asError,
  createFfsManagerCore,
  formatBytes,
  toHex
};
