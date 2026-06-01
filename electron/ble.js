const { ipcMain } = require("electron");

const BLE_DEVICE_LIST_CHANNEL = 'ble-device-list';

let pendingBluetoothSelectionCallback = null;
let pendingBluetoothSelectionWebContents = null;
const lastBluetoothDeviceSignatures = new WeakMap();
const pausedBluetoothDeviceUpdates = new WeakSet();
const cancelledBluetoothDeviceRequests = new WeakSet();
const preferredBluetoothDeviceSelections = new WeakMap();
let bluetoothChooserEventCount = 0;
let bluetoothPermissionHandlersInstalled = false;
let bleHandlersRegistered = false;

function logBle(...args) {
  console.log('[BLE]', ...args);
}

function normalizeBluetoothDevices(deviceList = []) {
  const devices = new Map();
  for (const device of deviceList) {
    if (!device) continue;
    const deviceId = device.deviceId || device.id || device.device_id || device.address;
    if (!deviceId) continue;
    devices.set(deviceId, {
      deviceId,
      deviceName: device.deviceName || device.name || device.device_name || 'BLE OTA Device',
    });
  }
  return Array.from(devices.values());
}

function sendBluetoothDeviceList(webContents, deviceList) {
  if (!webContents || webContents.isDestroyed()) return;
  if (pausedBluetoothDeviceUpdates.has(webContents)) return;
  const normalizedDevices = normalizeBluetoothDevices(deviceList);
  const signature = JSON.stringify(normalizedDevices.map(device => `${device.deviceId}:${device.deviceName}`));
  if (lastBluetoothDeviceSignatures.get(webContents) === signature) return;

  lastBluetoothDeviceSignatures.set(webContents, signature);
  logBle('send devices to renderer:', normalizedDevices.length, normalizedDevices.map(device => device.deviceName || device.deviceId).join(', '));
  webContents.send(BLE_DEVICE_LIST_CHANNEL, normalizedDevices);
}

function setupWebBluetoothPermissions(targetWindow) {
  if (bluetoothPermissionHandlersInstalled) return;
  bluetoothPermissionHandlersInstalled = true;

  const ses = targetWindow.webContents.session;

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission === 'bluetooth' || permission === 'bluetoothScanning') {
      logBle('permission check:', permission, requestingOrigin, details?.securityOrigin || '');
      return true;
    }
    return false;
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission === 'bluetooth' || permission === 'bluetoothScanning') {
      logBle('permission request:', permission, details?.requestingUrl || details?.securityOrigin || '');
      callback(true);
      return;
    }
    callback(false);
  });

  ses.setDevicePermissionHandler((details) => {
    if (details.deviceType === 'bluetooth' || details.deviceType === 'bluetoothLE') {
      logBle('device permission:', details.deviceType, details.origin || '');
      return true;
    }
    return false;
  });

  if (typeof ses.setBluetoothPairingHandler === 'function') {
    ses.setBluetoothPairingHandler((details, callback) => {
      logBle('pairing request:', details.deviceId || '', details.pairingKind || '');
      callback({ confirmed: true });
    });
  }
}

function registerWebBluetoothChooser(targetWindow) {
  logBle('register chooser for window');
  setupWebBluetoothPermissions(targetWindow);
  const targetWebContents = targetWindow.webContents;

  targetWebContents.on('select-bluetooth-device', (event, deviceList, callback) => {
    event.preventDefault();
    bluetoothChooserEventCount++;
    pendingBluetoothSelectionCallback = callback;
    pendingBluetoothSelectionWebContents = targetWebContents;

    if (cancelledBluetoothDeviceRequests.has(targetWebContents)) {
      cancelledBluetoothDeviceRequests.delete(targetWebContents);
      pendingBluetoothSelectionCallback('');
      pendingBluetoothSelectionCallback = null;
      pendingBluetoothSelectionWebContents = null;
      return;
    }

    const normalizedDevices = normalizeBluetoothDevices(deviceList);
    const preferredDeviceId = preferredBluetoothDeviceSelections.get(targetWebContents);
    if (preferredDeviceId) {
      const matchedDevice = normalizedDevices.find(device => device.deviceId === preferredDeviceId);
      if (matchedDevice) {
        logBle('auto selected preferred device:', matchedDevice.deviceName || matchedDevice.deviceId);
        preferredBluetoothDeviceSelections.delete(targetWebContents);
        pausedBluetoothDeviceUpdates.delete(targetWebContents);
        cancelledBluetoothDeviceRequests.delete(targetWebContents);
        pendingBluetoothSelectionCallback(preferredDeviceId);
        pendingBluetoothSelectionCallback = null;
        pendingBluetoothSelectionWebContents = null;
        return;
      }
    }

    if (pausedBluetoothDeviceUpdates.has(targetWebContents)) return;

    if (bluetoothChooserEventCount <= 5 || bluetoothChooserEventCount % 20 === 0) {
      const sample = (deviceList || []).slice(0, 5).map(device => ({
        keys: Object.keys(device || {}),
        deviceId: device?.deviceId || device?.id || device?.device_id || device?.address || '',
        deviceName: device?.deviceName || device?.name || device?.device_name || '',
      }));
      logBle('select-bluetooth-device event:', bluetoothChooserEventCount, 'raw count:', deviceList?.length || 0, 'sample:', JSON.stringify(sample));
    }
    sendBluetoothDeviceList(targetWebContents, normalizedDevices);
  });

  targetWindow.on('closed', () => {
    if (pendingBluetoothSelectionWebContents === targetWebContents) {
      pendingBluetoothSelectionCallback = null;
      pendingBluetoothSelectionWebContents = null;
    }
  });
}

function registerBleHandlers() {
  if (bleHandlersRegistered) return;
  bleHandlersRegistered = true;

  ipcMain.handle('ble-select-device', async (_event, deviceId) => {
    logBle('renderer selected device:', deviceId || '(empty)');
    if (!pendingBluetoothSelectionCallback) {
      return { success: false, error: '当前没有正在进行的 BLE 设备选择请求' };
    }
    if (pendingBluetoothSelectionWebContents) {
      preferredBluetoothDeviceSelections.delete(pendingBluetoothSelectionWebContents);
      pausedBluetoothDeviceUpdates.delete(pendingBluetoothSelectionWebContents);
      cancelledBluetoothDeviceRequests.delete(pendingBluetoothSelectionWebContents);
    }
    pendingBluetoothSelectionCallback(deviceId || '');
    pendingBluetoothSelectionCallback = null;
    pendingBluetoothSelectionWebContents = null;
    return { success: true };
  });

  ipcMain.handle('ble-cancel-device-request', async (event) => {
    logBle('renderer cancelled device request');
    if (pendingBluetoothSelectionCallback) {
      if (pendingBluetoothSelectionWebContents) {
        preferredBluetoothDeviceSelections.delete(pendingBluetoothSelectionWebContents);
        pausedBluetoothDeviceUpdates.delete(pendingBluetoothSelectionWebContents);
        cancelledBluetoothDeviceRequests.delete(pendingBluetoothSelectionWebContents);
      }
      pendingBluetoothSelectionCallback('');
      pendingBluetoothSelectionCallback = null;
      pendingBluetoothSelectionWebContents = null;
    } else {
      preferredBluetoothDeviceSelections.delete(event.sender);
      cancelledBluetoothDeviceRequests.add(event.sender);
    }
    return { success: true };
  });

  ipcMain.handle('ble-set-preferred-device', async (event, deviceId) => {
    if (!deviceId) {
      preferredBluetoothDeviceSelections.delete(event.sender);
      return { success: true };
    }
    logBle('renderer preferred device for request:', deviceId);
    preferredBluetoothDeviceSelections.set(event.sender, deviceId);
    pausedBluetoothDeviceUpdates.delete(event.sender);
    cancelledBluetoothDeviceRequests.delete(event.sender);
    lastBluetoothDeviceSignatures.delete(event.sender);
    return { success: true };
  });

  ipcMain.handle('ble-start-device-list-updates', async (event) => {
    preferredBluetoothDeviceSelections.delete(event.sender);
    pausedBluetoothDeviceUpdates.delete(event.sender);
    cancelledBluetoothDeviceRequests.delete(event.sender);
    lastBluetoothDeviceSignatures.delete(event.sender);
    return { success: true };
  });

  ipcMain.handle('ble-stop-device-list-updates', async (event) => {
    pausedBluetoothDeviceUpdates.add(event.sender);
    return { success: true };
  });

  ipcMain.handle('ble-debug-state', async () => ({
    hasPendingSelection: !!pendingBluetoothSelectionCallback,
    chooserEventCount: bluetoothChooserEventCount,
    permissionHandlersInstalled: bluetoothPermissionHandlersInstalled,
    hasDeferredCancel: pendingBluetoothSelectionWebContents
      ? cancelledBluetoothDeviceRequests.has(pendingBluetoothSelectionWebContents)
      : false,
    preferredDeviceId: pendingBluetoothSelectionWebContents
      ? preferredBluetoothDeviceSelections.get(pendingBluetoothSelectionWebContents) || ''
      : '',
    deviceListUpdatesPaused: pendingBluetoothSelectionWebContents
      ? pausedBluetoothDeviceUpdates.has(pendingBluetoothSelectionWebContents)
      : false,
  }));
}

module.exports = {
  registerBleHandlers,
  registerWebBluetoothChooser,
};