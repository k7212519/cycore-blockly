#!/usr/bin/env node
'use strict';

const readline = require('readline');

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

let noble;
try {
  noble = require('@abandonware/noble');
} catch (error) {
  write({
    event: 'fatal',
    data: {
      message: `Failed to load @abandonware/noble: ${asError(error)}`
    }
  });
  process.exit(1);
}

const peripherals = new Map();
const characteristicRefs = new Map();
const notificationHandlers = new Map();

let scanning = false;
let activePeripheral = null;
let shuttingDown = false;

function sendEvent(event, data = {}) {
  write({ event, data });
}

function sendResponse(id, ok, data = {}, error = '') {
  write({ id, ok, data, error });
}

function normalizeUuid(uuid) {
  return String(uuid || '')
    .trim()
    .toLowerCase()
    .replace(/^0x/, '')
    .replace(/-/g, '');
}

function displayUuid(uuid) {
  const normalized = normalizeUuid(uuid);
  if (normalized.length === 4) return `0x${normalized.toUpperCase()}`;
  return normalized || '-';
}

function characteristicKey(serviceUuid, characteristicUuid) {
  return `${normalizeUuid(serviceUuid)}:${normalizeUuid(characteristicUuid)}`;
}

function bufferToHex(buffer) {
  return Array.from(buffer || [])
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

function bufferToAscii(buffer) {
  return Array.from(buffer || [])
    .map(byte => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'))
    .join('');
}

function parseHex(text) {
  const clean = String(text || '').replace(/0x/gi, '').replace(/[^a-fA-F0-9]/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error('Hex payload must contain an even number of digits');
  }
  const bytes = [];
  for (let index = 0; index < clean.length; index += 2) {
    bytes.push(parseInt(clean.slice(index, index + 2), 16));
  }
  return Buffer.from(bytes);
}

function payloadToBuffer(payload, mode = 'hex') {
  if (mode === 'ascii') {
    return Buffer.from(String(payload || ''), 'utf8');
  }
  return parseHex(payload);
}

function normalizeUuidList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeUuid).filter(Boolean);
}

function callWithCallback(target, method, args = []) {
  return new Promise((resolve, reject) => {
    if (!target || typeof target[method] !== 'function') {
      reject(new Error(`${method} is not available`));
      return;
    }

    target[method](...args, (error, ...result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result.length <= 1 ? result[0] : result);
    });
  });
}

async function callAsync(target, asyncMethod, callbackMethod, args = []) {
  if (target && typeof target[asyncMethod] === 'function') {
    return await target[asyncMethod](...args);
  }
  return await callWithCallback(target, callbackMethod, args);
}

function serializePeripheral(peripheral) {
  const advertisement = peripheral.advertisement || {};
  return {
    id: peripheral.id || peripheral.uuid || peripheral.address,
    uuid: peripheral.uuid || '',
    address: peripheral.address || '',
    addressType: peripheral.addressType || '',
    name: advertisement.localName || peripheral.name || peripheral.advertisement?.localName || 'Unknown device',
    localName: advertisement.localName || '',
    rssi: typeof peripheral.rssi === 'number' ? peripheral.rssi : null,
    connectable: peripheral.connectable !== false,
    serviceUuids: Array.isArray(advertisement.serviceUuids) ? advertisement.serviceUuids.map(displayUuid) : [],
    manufacturerData: advertisement.manufacturerData ? bufferToHex(advertisement.manufacturerData) : '',
    txPowerLevel: typeof advertisement.txPowerLevel === 'number' ? advertisement.txPowerLevel : null
  };
}

function serializeCharacteristic(service, characteristic) {
  return {
    uuid: displayUuid(characteristic.uuid),
    rawUuid: normalizeUuid(characteristic.uuid),
    serviceUuid: displayUuid(service.uuid),
    rawServiceUuid: normalizeUuid(service.uuid),
    properties: characteristic.properties || [],
    lastValueHex: '',
    lastValueAscii: '',
    notifying: notificationHandlers.has(characteristicKey(service.uuid, characteristic.uuid))
  };
}

function serializeService(service, characteristics) {
  return {
    uuid: displayUuid(service.uuid),
    rawUuid: normalizeUuid(service.uuid),
    characteristics: characteristics.map(characteristic => serializeCharacteristic(service, characteristic))
  };
}

async function startScan(options = {}) {
  const serviceUuids = normalizeUuidList(options.serviceUuids);
  const allowDuplicates = options.allowDuplicates !== false;

  if (noble.state !== 'poweredOn') {
    throw new Error(`Bluetooth adapter is ${noble.state || 'unknown'}`);
  }

  if (scanning) {
    await stopScan();
  }

  await callAsync(noble, 'startScanningAsync', 'startScanning', [serviceUuids, allowDuplicates]);
  scanning = true;
  return { scanning, serviceUuids, allowDuplicates };
}

async function stopScan() {
  if (!scanning) {
    return { scanning: false };
  }
  await callAsync(noble, 'stopScanningAsync', 'stopScanning', []);
  scanning = false;
  return { scanning };
}

async function connectDevice(options = {}) {
  const id = options.id;
  const peripheral = peripherals.get(id);
  if (!peripheral) {
    throw new Error('Device is not in the scan cache');
  }

  if (activePeripheral && activePeripheral.id !== peripheral.id) {
    await disconnectDevice();
  }

  if (scanning) {
    await stopScan();
  }

  if (peripheral.state !== 'connected') {
    await callAsync(peripheral, 'connectAsync', 'connect', []);
  }

  activePeripheral = peripheral;
  peripheral.once('disconnect', () => {
    if (activePeripheral && activePeripheral.id === peripheral.id) {
      clearGattCache();
      activePeripheral = null;
      sendEvent('disconnected', { id: peripheral.id });
    }
  });

  const gatt = await discoverGatt();
  sendEvent('connected', { device: serializePeripheral(peripheral), services: gatt.services });
  return { device: serializePeripheral(peripheral), services: gatt.services };
}

async function disconnectDevice() {
  if (!activePeripheral) {
    clearGattCache();
    return { connected: false };
  }

  const disconnectedId = activePeripheral.id;
  const peripheral = activePeripheral;
  clearGattCache();
  activePeripheral = null;

  if (peripheral.state === 'connected') {
    await callAsync(peripheral, 'disconnectAsync', 'disconnect', []);
  }

  sendEvent('disconnected', { id: disconnectedId });
  return { connected: false };
}

function clearGattCache() {
  for (const [key, entry] of notificationHandlers.entries()) {
    entry.characteristic.removeListener('data', entry.handler);
    notificationHandlers.delete(key);
  }
  characteristicRefs.clear();
}

async function discoverGatt(options = {}) {
  if (!activePeripheral || activePeripheral.state !== 'connected') {
    throw new Error('No connected BLE device');
  }

  clearGattCache();
  const serviceUuids = normalizeUuidList(options.serviceUuids);
  const services = await callAsync(activePeripheral, 'discoverServicesAsync', 'discoverServices', [serviceUuids]);
  const result = [];

  for (const service of services || []) {
    const characteristics = await callAsync(service, 'discoverCharacteristicsAsync', 'discoverCharacteristics', [[]]);
    for (const characteristic of characteristics || []) {
      characteristicRefs.set(characteristicKey(service.uuid, characteristic.uuid), { service, characteristic });
    }
    result.push(serializeService(service, characteristics || []));
  }

  return { services: result };
}

function getCharacteristic(options = {}) {
  const key = characteristicKey(options.serviceUuid, options.characteristicUuid);
  const entry = characteristicRefs.get(key);
  if (!entry) {
    throw new Error('Characteristic is not in the discovered GATT cache');
  }
  return { key, ...entry };
}

async function readCharacteristic(options = {}) {
  const { service, characteristic } = getCharacteristic(options);
  const value = await callAsync(characteristic, 'readAsync', 'read', []);
  const data = Buffer.from(value || []);
  return {
    serviceUuid: displayUuid(service.uuid),
    characteristicUuid: displayUuid(characteristic.uuid),
    valueHex: bufferToHex(data),
    valueAscii: bufferToAscii(data),
    byteLength: data.length
  };
}

async function writeCharacteristic(options = {}) {
  const { service, characteristic } = getCharacteristic(options);
  const value = payloadToBuffer(options.payload, options.mode);
  const withoutResponse = options.withoutResponse === true;
  await callAsync(characteristic, 'writeAsync', 'write', [value, withoutResponse]);
  return {
    serviceUuid: displayUuid(service.uuid),
    characteristicUuid: displayUuid(characteristic.uuid),
    valueHex: bufferToHex(value),
    valueAscii: bufferToAscii(value),
    byteLength: value.length,
    withoutResponse
  };
}

async function subscribeCharacteristic(options = {}) {
  const { key, service, characteristic } = getCharacteristic(options);
  if (!notificationHandlers.has(key)) {
    const handler = (data, isNotification) => {
      const value = Buffer.from(data || []);
      sendEvent('notification', {
        serviceUuid: displayUuid(service.uuid),
        characteristicUuid: displayUuid(characteristic.uuid),
        valueHex: bufferToHex(value),
        valueAscii: bufferToAscii(value),
        byteLength: value.length,
        isNotification: isNotification !== false
      });
    };
    characteristic.on('data', handler);
    notificationHandlers.set(key, { characteristic, handler });
  }

  await callAsync(characteristic, 'subscribeAsync', 'subscribe', []);
  return {
    serviceUuid: displayUuid(service.uuid),
    characteristicUuid: displayUuid(characteristic.uuid),
    notifying: true
  };
}

async function unsubscribeCharacteristic(options = {}) {
  const { key, service, characteristic } = getCharacteristic(options);
  const entry = notificationHandlers.get(key);
  if (entry) {
    characteristic.removeListener('data', entry.handler);
    notificationHandlers.delete(key);
  }

  await callAsync(characteristic, 'unsubscribeAsync', 'unsubscribe', []);
  return {
    serviceUuid: displayUuid(service.uuid),
    characteristicUuid: displayUuid(characteristic.uuid),
    notifying: false
  };
}

async function shutdown() {
  shuttingDown = true;
  try {
    await stopScan();
  } catch (error) {
    sendEvent('log', { level: 'warn', message: asError(error) });
  }
  try {
    await disconnectDevice();
  } catch (error) {
    sendEvent('log', { level: 'warn', message: asError(error) });
  }
  setTimeout(() => process.exit(0), 10);
  return { closing: true };
}

async function handleCommand(message) {
  const id = message.id;
  try {
    let data;
    switch (message.action) {
      case 'status':
        data = { state: noble.state || 'unknown', scanning, connected: !!activePeripheral };
        break;
      case 'startScan':
        data = await startScan(message);
        break;
      case 'stopScan':
        data = await stopScan();
        break;
      case 'connect':
        data = await connectDevice(message);
        break;
      case 'disconnect':
        data = await disconnectDevice();
        break;
      case 'discoverGatt':
        data = await discoverGatt(message);
        break;
      case 'read':
        data = await readCharacteristic(message);
        break;
      case 'write':
        data = await writeCharacteristic(message);
        break;
      case 'subscribe':
        data = await subscribeCharacteristic(message);
        break;
      case 'unsubscribe':
        data = await unsubscribeCharacteristic(message);
        break;
      case 'shutdown':
        data = await shutdown();
        break;
      default:
        throw new Error(`Unknown action: ${message.action}`);
    }
    sendResponse(id, true, data);
  } catch (error) {
    sendResponse(id, false, {}, asError(error));
  }
}

noble.on('stateChange', state => {
  sendEvent('state', { state, scanning });
  if (state !== 'poweredOn' && scanning) {
    noble.stopScanning();
    scanning = false;
    sendEvent('scanStop', { scanning });
  }
});

noble.on('scanStart', () => {
  scanning = true;
  sendEvent('scanStart', { scanning });
});

noble.on('scanStop', () => {
  scanning = false;
  sendEvent('scanStop', { scanning });
});

noble.on('discover', peripheral => {
  const id = peripheral.id || peripheral.uuid || peripheral.address;
  if (!id) return;
  peripherals.set(id, peripheral);
  sendEvent('device', serializePeripheral(peripheral));
});

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on('line', line => {
  const text = line.trim();
  if (!text) return;
  try {
    void handleCommand(JSON.parse(text));
  } catch (error) {
    sendEvent('error', { message: asError(error) });
  }
});

process.on('SIGTERM', () => {
  if (!shuttingDown) {
    void shutdown();
  }
});

process.on('SIGINT', () => {
  if (!shuttingDown) {
    void shutdown();
  }
});

process.on('uncaughtException', error => {
  sendEvent('fatal', { message: asError(error) });
  process.exit(1);
});

process.on('unhandledRejection', error => {
  sendEvent('error', { message: asError(error) });
});

sendEvent('ready', {
  state: noble.state || 'unknown',
  pid: process.pid
});
