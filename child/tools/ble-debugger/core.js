'use strict';

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function loadNoble() {
  try {
    return require('@abandonware/noble');
  } catch (error) {
    throw new Error(`Failed to load @abandonware/noble: ${asError(error)}`);
  }
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

function numberOption(value, defaultValue, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, parsed);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function createBleDebuggerCore(options = {}) {
  const noble = options.noble || loadNoble();
  const sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : null;
  const peripherals = new Map();
  const characteristicRefs = new Map();
  const notificationHandlers = new Map();

  let scanning = false;
  let activePeripheral = null;

  const emit = (event, data = {}) => {
    if (sendEvent) sendEvent(event, data);
  };

  function status() {
    return {
      state: noble.state || 'unknown',
      scanning,
      connected: !!activePeripheral
    };
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

  async function waitForPoweredOn(timeoutMs = 10000) {
    if (noble.state === 'poweredOn') {
      return noble.state;
    }

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

  function clearGattCache() {
    for (const [key, entry] of notificationHandlers.entries()) {
      entry.characteristic.removeListener('data', entry.handler);
      notificationHandlers.delete(key);
    }
    characteristicRefs.clear();
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
        emit('disconnected', { id: peripheral.id });
      }
    });

    const gatt = await discoverGatt();
    emit('connected', { device: serializePeripheral(peripheral), services: gatt.services });
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

    emit('disconnected', { id: disconnectedId });
    return { connected: false };
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
        emit('notification', {
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
    try {
      await stopScan();
    } catch (error) {
      emit('log', { level: 'warn', message: asError(error) });
    }
    try {
      await disconnectDevice();
    } catch (error) {
      emit('log', { level: 'warn', message: asError(error) });
    }
    return { closing: true };
  }

  async function cleanup() {
    try {
      if (scanning) await stopScan();
    } catch {}
    try {
      if (activePeripheral) await disconnectDevice();
    } catch {}
  }

  function matchesDevice(device, selector) {
    const id = String(selector.id || selector.device || '').toLowerCase();
    const address = String(selector.address || '').toLowerCase();
    const name = String(selector.name || '').toLowerCase();
    const contains = String(selector.nameContains || selector.contains || '').toLowerCase();
    const deviceId = String(device.id || '').toLowerCase();
    const uuid = String(device.uuid || '').toLowerCase();
    const deviceAddress = String(device.address || '').toLowerCase();
    const deviceName = String(device.name || device.localName || '').toLowerCase();

    if (id && ![deviceId, uuid, deviceAddress].includes(id)) return false;
    if (address && deviceAddress !== address) return false;
    if (name && deviceName !== name) return false;
    if (contains && !deviceName.includes(contains)) return false;
    return !!(id || address || name || contains);
  }

  async function scanDevices(options = {}) {
    const durationMs = numberOption(options.durationMs, 5000, 250);
    const waitMs = numberOption(options.waitMs, 10000, 100);
    const serviceUuids = normalizeUuidList(options.serviceUuids);
    const allowDuplicates = options.allowDuplicates === true;
    const devices = new Map();

    await waitForPoweredOn(waitMs);

    const onDiscover = peripheral => {
      const id = peripheral.id || peripheral.uuid || peripheral.address;
      if (!id) return;
      peripherals.set(id, peripheral);
      devices.set(id, serializePeripheral(peripheral));
    };

    noble.on('discover', onDiscover);
    try {
      await startScan({ serviceUuids, allowDuplicates });
      await sleep(durationMs);
      await stopScan();
    } finally {
      noble.removeListener('discover', onDiscover);
      if (scanning) {
        await stopScan().catch(() => undefined);
      }
    }

    return {
      state: noble.state || 'unknown',
      durationMs,
      serviceUuids,
      devices: Array.from(devices.values()).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
    };
  }

  async function findPeripheral(selector = {}) {
    const waitMs = numberOption(selector.waitMs, 10000, 100);
    const scanMs = numberOption(selector.scanMs || selector.durationMs, 10000, 250);
    const serviceUuids = normalizeUuidList(selector.scanServiceUuids);
    const allowDuplicates = selector.allowDuplicates !== false;
    const startedAt = Date.now();

    await waitForPoweredOn(waitMs);

    for (const peripheral of peripherals.values()) {
      const device = serializePeripheral(peripheral);
      if (matchesDevice(device, selector)) {
        return peripheral;
      }
    }

    return await new Promise((resolve, reject) => {
      let settled = false;

      const finish = (error, peripheral = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        noble.removeListener('discover', onDiscover);

        const stop = scanning ? stopScan().catch(() => undefined) : Promise.resolve();
        stop.finally(() => {
          if (error) reject(error);
          else resolve(peripheral);
        });
      };

      const timer = setTimeout(() => {
        finish(new Error(`BLE device was not found within ${scanMs} ms`));
      }, scanMs);

      const onDiscover = peripheral => {
        const id = peripheral.id || peripheral.uuid || peripheral.address;
        if (!id) return;
        peripherals.set(id, peripheral);
        const device = serializePeripheral(peripheral);
        if (matchesDevice(device, selector)) {
          finish(null, peripheral);
        }
      };

      noble.on('discover', onDiscover);
      startScan({ serviceUuids, allowDuplicates }).catch(error => finish(error));
    }).then(peripheral => {
      peripheral.__ailyScanElapsedMs = Date.now() - startedAt;
      return peripheral;
    });
  }

  async function connectBySelector(selector = {}) {
    const peripheral = await findPeripheral(selector);
    const id = peripheral.id || peripheral.uuid || peripheral.address;
    const result = await connectDevice({ id });
    return {
      ...result,
      scanElapsedMs: peripheral.__ailyScanElapsedMs || 0
    };
  }

  async function withConnectedDevice(selector, task) {
    try {
      const connection = await connectBySelector(selector);
      const result = await task(connection);
      return {
        device: connection.device,
        ...result
      };
    } finally {
      await disconnectDevice().catch(() => undefined);
    }
  }

  async function readBySelector(options = {}) {
    return await withConnectedDevice(options, async () => ({
      value: await readCharacteristic(options)
    }));
  }

  async function writeBySelector(options = {}) {
    return await withConnectedDevice(options, async () => ({
      value: await writeCharacteristic(options)
    }));
  }

  async function notifyBySelector(options = {}) {
    const durationMs = numberOption(options.durationMs, 10000, 250);
    return await withConnectedDevice(options, async () => {
      const notifications = [];
      const { service, characteristic } = getCharacteristic(options);
      const handler = (data, isNotification) => {
        const value = Buffer.from(data || []);
        notifications.push({
          time: new Date().toISOString(),
          serviceUuid: displayUuid(service.uuid),
          characteristicUuid: displayUuid(characteristic.uuid),
          valueHex: bufferToHex(value),
          valueAscii: bufferToAscii(value),
          byteLength: value.length,
          isNotification: isNotification !== false
        });
      };

      const key = characteristicKey(service.uuid, characteristic.uuid);
      characteristic.on('data', handler);
      notificationHandlers.set(key, { characteristic, handler });

      try {
        await callAsync(characteristic, 'subscribeAsync', 'subscribe', []);
        await sleep(durationMs);
        await callAsync(characteristic, 'unsubscribeAsync', 'unsubscribe', []);
      } finally {
        characteristic.removeListener('data', handler);
        notificationHandlers.delete(key);
      }

      return {
        subscription: {
          serviceUuid: displayUuid(service.uuid),
          characteristicUuid: displayUuid(characteristic.uuid),
          durationMs
        },
        notifications
      };
    });
  }

  async function executeAction(message = {}) {
    switch (message.action) {
      case 'status':
        return status();
      case 'startScan':
        return await startScan(message);
      case 'stopScan':
        return await stopScan();
      case 'connect':
        return await connectDevice(message);
      case 'disconnect':
        return await disconnectDevice();
      case 'discoverGatt':
        return await discoverGatt(message);
      case 'read':
        return await readCharacteristic(message);
      case 'write':
        return await writeCharacteristic(message);
      case 'subscribe':
        return await subscribeCharacteristic(message);
      case 'unsubscribe':
        return await unsubscribeCharacteristic(message);
      case 'shutdown':
        return await shutdown();
      default:
        throw new Error(`Unknown action: ${message.action}`);
    }
  }

  noble.on('stateChange', state => {
    emit('state', { state, scanning });
    if (state !== 'poweredOn' && scanning) {
      noble.stopScanning();
      scanning = false;
      emit('scanStop', { scanning });
    }
  });

  noble.on('scanStart', () => {
    scanning = true;
    emit('scanStart', { scanning });
  });

  noble.on('scanStop', () => {
    scanning = false;
    emit('scanStop', { scanning });
  });

  noble.on('discover', peripheral => {
    const id = peripheral.id || peripheral.uuid || peripheral.address;
    if (!id) return;
    peripherals.set(id, peripheral);
    emit('device', serializePeripheral(peripheral));
  });

  return {
    noble,
    status,
    startScan,
    stopScan,
    connectDevice,
    disconnectDevice,
    discoverGatt,
    readCharacteristic,
    writeCharacteristic,
    subscribeCharacteristic,
    unsubscribeCharacteristic,
    shutdown,
    cleanup,
    waitForPoweredOn,
    scanDevices,
    findPeripheral,
    connectBySelector,
    withConnectedDevice,
    readBySelector,
    writeBySelector,
    notifyBySelector,
    executeAction
  };
}

module.exports = {
  asError,
  createBleDebuggerCore,
  normalizeUuid,
  displayUuid,
  bufferToHex,
  bufferToAscii
};
