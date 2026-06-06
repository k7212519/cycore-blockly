'use strict';

const app = document.getElementById('app');
const token = new URLSearchParams(window.location.search).get('token') || '';
const state = {
  backendStatus: 'connecting',
  adapterState: 'unknown',
  backendPid: 0,
  scanning: false,
  allowDuplicates: true,
  serviceFilter: '',
  devices: [],
  selectedDeviceId: '',
  connectedDeviceId: '',
  connectingDeviceId: '',
  services: [],
  selectedServiceUuid: '',
  selectedCharacteristicUuid: '',
  payloadMode: 'hex',
  payload: '01 02 03 04',
  writeWithoutResponse: false,
  logs: []
};

let ws = null;
let requestSeq = 0;
const pendingRequests = new Map();
let logSeq = 0;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function statusLabel() {
  if (state.backendStatus === 'ready') return 'Backend ready';
  if (state.backendStatus === 'error') return 'Backend error';
  if (state.backendStatus === 'closed') return 'Backend closed';
  return 'Connecting backend';
}

function adapterLabel() {
  const labels = {
    poweredOn: 'Bluetooth powered on',
    poweredOff: 'Bluetooth powered off',
    unauthorized: 'Bluetooth unauthorized',
    unsupported: 'Bluetooth unsupported',
    resetting: 'Bluetooth resetting',
    unknown: 'Bluetooth unknown'
  };
  return labels[state.adapterState] || `Bluetooth ${state.adapterState}`;
}

function rssiClass(device) {
  if (device.rssi === null || device.rssi === undefined) return 'weak';
  if (device.rssi >= -60) return 'strong';
  if (device.rssi >= -78) return 'medium';
  return 'weak';
}

function hasProperty(characteristic, property) {
  return !!characteristic?.properties?.includes(property);
}

function canRead(characteristic) {
  return hasProperty(characteristic, 'read');
}

function canWrite(characteristic) {
  return hasProperty(characteristic, 'write') || hasProperty(characteristic, 'writeWithoutResponse');
}

function canNotify(characteristic) {
  return hasProperty(characteristic, 'notify') || hasProperty(characteristic, 'indicate');
}

function selectedDevice() {
  return state.devices.find(device => device.id === state.selectedDeviceId || device.id === state.connectedDeviceId);
}

function selectedCharacteristic() {
  for (const service of state.services) {
    const match = service.characteristics.find(characteristic =>
      characteristic.uuid === state.selectedCharacteristicUuid &&
      service.uuid === state.selectedServiceUuid
    );
    if (match) return match;
  }
  return null;
}

function pushLog(type, label, detail = '', value = '') {
  state.logs.unshift({
    id: ++logSeq,
    time: new Date().toLocaleTimeString(),
    type,
    label,
    detail,
    value
  });
  state.logs = state.logs.slice(0, 160);
  render();
}

function renderDevices() {
  if (!state.devices.length) {
    return '<div class="empty-state">No BLE devices found yet</div>';
  }

  return state.devices.map(device => {
    const active = state.selectedDeviceId === device.id ? ' active' : '';
    const connected = state.connectedDeviceId === device.id ? ' connected' : '';
    const connecting = state.connectingDeviceId === device.id;
    return `
      <div class="device-row${active}${connected}" data-action="select-device" data-id="${escapeAttr(device.id)}">
        <span class="signal ${rssiClass(device)}">${escapeHtml(device.rssi ?? '-')}</span>
        <span class="device-main">
          <strong>${escapeHtml(device.name || 'Unknown')}</strong>
          <span class="mono">${escapeHtml(device.address || device.id)}</span>
        </span>
        <button type="button" class="device-action" data-action="connect-device" data-id="${escapeAttr(device.id)}" ${connecting || state.connectedDeviceId === device.id ? 'disabled' : ''} title="Connect">
          ${connecting ? '...' : '>'}
        </button>
      </div>
    `;
  }).join('');
}

function renderGatt() {
  if (!state.services.length) {
    return '<div class="empty-state">No GATT database loaded</div>';
  }

  return state.services.map(service => `
    <div class="service-block">
      <div class="service-title">
        <span>Service</span>
        <span class="mono">${escapeHtml(service.uuid)}</span>
      </div>
      ${service.characteristics.map(characteristic => {
        const active = state.selectedServiceUuid === service.uuid && state.selectedCharacteristicUuid === characteristic.uuid ? ' active' : '';
        return `
          <button type="button" class="characteristic-row${active}" data-action="select-characteristic" data-service="${escapeAttr(service.uuid)}" data-characteristic="${escapeAttr(characteristic.uuid)}">
            <span class="mono">${escapeHtml(characteristic.uuid)}</span>
            <span class="property-list">
              ${(characteristic.properties || []).map(property => `<code>${escapeHtml(property)}</code>`).join('')}
            </span>
          </button>
        `;
      }).join('')}
    </div>
  `).join('');
}

function renderOperation() {
  const characteristic = selectedCharacteristic();
  if (!characteristic) {
    return '<div class="empty-state">Select a characteristic</div>';
  }

  return `
    <div class="selected-characteristic">
      <span class="mono">${escapeHtml(characteristic.serviceUuid)}</span>
      <strong class="mono">${escapeHtml(characteristic.uuid)}</strong>
    </div>

    <div class="operation-buttons">
      <button type="button" data-action="read-selected" ${canRead(characteristic) ? '' : 'disabled'}>Read</button>
      <button type="button" data-action="toggle-notify" class="${characteristic.notifying ? 'active' : ''}" ${canNotify(characteristic) ? '' : 'disabled'}>
        ${characteristic.notifying ? 'Unsubscribe' : 'Subscribe'}
      </button>
    </div>

    <div class="field-grid">
      <label class="field">
        <span>Write mode</span>
        <select data-field="payloadMode">
          <option value="hex" ${state.payloadMode === 'hex' ? 'selected' : ''}>Hex</option>
          <option value="ascii" ${state.payloadMode === 'ascii' ? 'selected' : ''}>ASCII</option>
        </select>
      </label>
      <label class="check-field">
        <input type="checkbox" data-field="writeWithoutResponse" ${state.writeWithoutResponse ? 'checked' : ''}>
        <span>Without response</span>
      </label>
    </div>

    <label class="field payload">
      <span>Payload</span>
      <textarea class="mono" data-field="payload">${escapeHtml(state.payload)}</textarea>
    </label>

    <div class="actions">
      <button type="button" class="primary" data-action="write-selected" ${canWrite(characteristic) ? '' : 'disabled'}>Write</button>
    </div>

    <div class="value-preview">
      <div class="result-title">Last value</div>
      <pre class="mono">${escapeHtml(characteristic.lastValueHex || '-')}</pre>
      ${characteristic.lastValueAscii ? `<code>${escapeHtml(characteristic.lastValueAscii)}</code>` : ''}
    </div>
  `;
}

function renderLogs() {
  if (!state.logs.length) {
    return '<div class="empty-state">No log entries</div>';
  }

  return state.logs.map(log => `
    <div class="log-row ${escapeAttr(log.type)}">
      <span class="time">${escapeHtml(log.time)}</span>
      <span class="label">${escapeHtml(log.label)}</span>
      ${log.detail ? `<span class="detail mono">${escapeHtml(log.detail)}</span>` : '<span></span>'}
      ${log.value ? `<span class="value mono">${escapeHtml(log.value)}</span>` : ''}
    </div>
  `).join('');
}

function render() {
  const backendClass = state.backendStatus === 'ready' ? 'ready' : state.backendStatus === 'error' ? 'error' : '';
  const adapterClass = state.adapterState === 'poweredOn' ? 'ready' : 'error';
  const connected = selectedDevice();

  app.className = `ble-debugger ${state.backendStatus === 'connecting' ? 'loading' : ''} ${state.backendStatus === 'error' ? 'failed' : ''}`;
  app.innerHTML = `
    <div class="topbar">
      <div class="status-strip">
        <span class="status ${backendClass}">${statusLabel()}</span>
        <span class="status ${adapterClass}">${adapterLabel()}</span>
        ${state.backendPid ? `<span class="pid mono">PID ${escapeHtml(state.backendPid)}</span>` : ''}
      </div>
      <div class="actions">
        <button type="button" data-action="reconnect" ${state.backendStatus === 'connecting' ? 'disabled' : ''}>Reconnect UI</button>
      </div>
    </div>

    <div class="workspace-grid">
      <section class="panel scan-panel">
        <div class="panel-title">
          <span>Scan</span>
          <button type="button" class="icon-action" data-action="clear-devices" title="Clear devices">x</button>
        </div>
        <div class="field-row">
          <label class="field">
            <span>Service filter</span>
            <input type="text" data-field="serviceFilter" value="${escapeAttr(state.serviceFilter)}" placeholder="180D, FFE0">
          </label>
          <label class="check-field">
            <input type="checkbox" data-field="allowDuplicates" ${state.allowDuplicates ? 'checked' : ''}>
            <span>Duplicates</span>
          </label>
        </div>
        <div class="actions">
          <button type="button" class="primary" data-action="start-scan" ${state.scanning || state.backendStatus !== 'ready' ? 'disabled' : ''}>Start scan</button>
          <button type="button" data-action="stop-scan" ${state.scanning ? '' : 'disabled'}>Stop</button>
        </div>
        <div class="device-list">${renderDevices()}</div>
      </section>

      <section class="panel gatt-panel">
        <div class="panel-title">
          <span>GATT</span>
          <div class="title-actions">
            <button type="button" class="icon-action" data-action="refresh-gatt" ${state.connectedDeviceId ? '' : 'disabled'} title="Refresh">r</button>
            <button type="button" class="icon-action" data-action="disconnect" ${state.connectedDeviceId ? '' : 'disabled'} title="Disconnect">-</button>
          </div>
        </div>
        <div class="connected-device">
          ${state.connectedDeviceId && connected ? `
            <strong>${escapeHtml(connected.name || 'Unknown')}</strong>
            <span class="mono">${escapeHtml(connected.address || connected.id)}</span>
          ` : '<span>No device connected</span>'}
        </div>
        <div class="gatt-list">${renderGatt()}</div>
      </section>

      <section class="panel operation-panel">
        <div class="panel-title">Operation</div>
        ${renderOperation()}
      </section>

      <section class="panel log-panel">
        <div class="panel-title">
          <span>Log</span>
          <button type="button" class="icon-action" data-action="clear-logs" title="Clear logs">x</button>
        </div>
        <div class="log-list">${renderLogs()}</div>
      </section>
    </div>

    <div class="overlay">${state.backendStatus === 'error' ? 'BLE debugger backend connection failed' : 'Connecting BLE debugger...'}</div>
  `;
}

function updateFromInputs() {
  const serviceFilter = app.querySelector('[data-field="serviceFilter"]');
  const allowDuplicates = app.querySelector('[data-field="allowDuplicates"]');
  const payloadMode = app.querySelector('[data-field="payloadMode"]');
  const payload = app.querySelector('[data-field="payload"]');
  const withoutResponse = app.querySelector('[data-field="writeWithoutResponse"]');

  if (serviceFilter) state.serviceFilter = serviceFilter.value;
  if (allowDuplicates) state.allowDuplicates = allowDuplicates.checked;
  if (payloadMode) state.payloadMode = payloadMode.value;
  if (payload) state.payload = payload.value;
  if (withoutResponse) state.writeWithoutResponse = withoutResponse.checked;
}

function parseServiceFilter() {
  const tokens = state.serviceFilter
    .split(/[\s,;]+/)
    .map(token => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const normalized = token.replace(/^0x/i, '').replace(/-/g, '');
    if (!/^[a-fA-F0-9]{4}$|^[a-fA-F0-9]{32}$/.test(normalized)) {
      pushLog('error', 'Invalid UUID', token);
      return null;
    }
  }

  return tokens;
}

function selectFirstCharacteristic() {
  const firstService = state.services[0];
  const firstCharacteristic = firstService?.characteristics?.[0];
  if (!firstService || !firstCharacteristic) {
    state.selectedServiceUuid = '';
    state.selectedCharacteristicUuid = '';
    return;
  }

  const stillExists = state.services.some(service =>
    service.uuid === state.selectedServiceUuid &&
    service.characteristics.some(characteristic => characteristic.uuid === state.selectedCharacteristicUuid)
  );

  if (!stillExists) {
    state.selectedServiceUuid = firstService.uuid;
    state.selectedCharacteristicUuid = firstCharacteristic.uuid;
  }
}

function upsertDevice(device) {
  if (!device?.id) return;
  const index = state.devices.findIndex(item => item.id === device.id);
  if (index >= 0) {
    state.devices[index] = { ...state.devices[index], ...device };
  } else {
    state.devices.unshift(device);
  }

  state.devices = [...state.devices]
    .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
    .slice(0, 120);
  render();
}

function updateCharacteristic(serviceUuid, characteristicUuid, patch) {
  state.services = state.services.map(service => {
    if (service.uuid !== serviceUuid) return service;
    return {
      ...service,
      characteristics: service.characteristics.map(characteristic =>
        characteristic.uuid === characteristicUuid ? { ...characteristic, ...patch } : characteristic
      )
    };
  });
}

function request(method, params = {}, timeoutMs = 15000) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('WebSocket is not connected'));
  }

  const id = ++requestSeq;
  const payload = JSON.stringify({ id, method, params });

  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out: ${method}`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
  });

  ws.send(payload);
  return response;
}

function handleEvent(event, data = {}) {
  switch (event) {
    case 'ready':
      state.backendStatus = 'ready';
      state.backendPid = Number(data.pid) || 0;
      state.adapterState = data.state || state.adapterState;
      break;
    case 'state':
      state.adapterState = data.state || 'unknown';
      state.scanning = !!data.scanning;
      break;
    case 'scanStart':
      state.scanning = true;
      break;
    case 'scanStop':
      state.scanning = false;
      break;
    case 'device':
      upsertDevice(data);
      return;
    case 'connected':
      state.connectedDeviceId = data.device?.id || state.connectedDeviceId;
      state.selectedDeviceId = state.connectedDeviceId;
      state.services = data.services || state.services;
      selectFirstCharacteristic();
      break;
    case 'disconnected':
      state.connectedDeviceId = '';
      state.services = [];
      state.selectedServiceUuid = '';
      state.selectedCharacteristicUuid = '';
      break;
    case 'notification':
      updateCharacteristic(data.serviceUuid, data.characteristicUuid, {
        lastValueHex: data.valueHex,
        lastValueAscii: data.valueAscii,
        notifying: true
      });
      pushLog('notify', 'Notification', `${data.characteristicUuid}, ${data.byteLength} B`, data.valueHex);
      return;
    case 'fatal':
    case 'error':
      state.backendStatus = 'error';
      pushLog('error', 'Backend error', data.message || '');
      return;
    case 'log':
      pushLog('system', 'Backend log', data.message || '');
      return;
    default:
      break;
  }
  render();
}

function handleMessage(raw) {
  const message = JSON.parse(raw);
  if (typeof message.id === 'number') {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || 'BLE request failed'));
    }
    return;
  }

  if (message.event) {
    handleEvent(message.event, message.data || {});
  }
}

function connectWs() {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('WebSocket reconnecting'));
  }
  pendingRequests.clear();

  if (ws) {
    ws.close();
    ws = null;
  }

  state.backendStatus = 'connecting';
  render();

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.addEventListener('open', async () => {
    try {
      const status = await request('status');
      state.adapterState = status.state || state.adapterState;
      state.scanning = !!status.scanning;
      state.backendStatus = 'ready';
      pushLog('system', 'Backend ready');
    } catch (error) {
      state.backendStatus = 'error';
      pushLog('error', 'Status failed', error.message);
    }
    render();
  });

  ws.addEventListener('message', event => {
    try {
      handleMessage(event.data);
    } catch (error) {
      pushLog('error', 'Message parse failed', error.message);
    }
  });

  ws.addEventListener('close', () => {
    if (state.backendStatus !== 'error') {
      state.backendStatus = 'closed';
      pushLog('system', 'WebSocket closed');
    }
    render();
  });

  ws.addEventListener('error', () => {
    state.backendStatus = 'error';
    render();
  });
}

async function startScan() {
  const serviceUuids = parseServiceFilter();
  if (serviceUuids === null) return;

  try {
    await request('startScan', {
      serviceUuids,
      allowDuplicates: state.allowDuplicates
    });
    state.scanning = true;
    pushLog('scan', 'Scan started');
  } catch (error) {
    pushLog('error', 'Scan failed', error.message);
  }
}

async function stopScan() {
  try {
    await request('stopScan');
    state.scanning = false;
    pushLog('scan', 'Scan stopped');
  } catch (error) {
    pushLog('error', 'Scan failed', error.message);
  }
}

async function connectDevice(id) {
  const device = state.devices.find(item => item.id === id);
  if (!device) return;

  state.selectedDeviceId = id;
  state.connectingDeviceId = id;
  render();

  try {
    const result = await request('connect', { id }, 30000);
    state.connectedDeviceId = result.device.id;
    state.services = result.services || [];
    selectFirstCharacteristic();
    pushLog('connect', 'Device connected', `${result.device.name || 'Unknown'} (${result.device.address || result.device.id})`);
  } catch (error) {
    pushLog('error', 'Connect failed', error.message);
  } finally {
    state.connectingDeviceId = '';
    render();
  }
}

async function disconnectDevice() {
  try {
    await request('disconnect');
    state.connectedDeviceId = '';
    state.services = [];
    state.selectedServiceUuid = '';
    state.selectedCharacteristicUuid = '';
    pushLog('connect', 'Device disconnected');
  } catch (error) {
    pushLog('error', 'Disconnect failed', error.message);
  }
}

async function refreshGatt() {
  if (!state.connectedDeviceId) return;

  try {
    const result = await request('discoverGatt', {}, 30000);
    state.services = result.services || [];
    selectFirstCharacteristic();
    pushLog('system', 'GATT refreshed');
  } catch (error) {
    pushLog('error', 'GATT failed', error.message);
  }
}

async function readSelected() {
  const characteristic = selectedCharacteristic();
  if (!characteristic || !canRead(characteristic)) return;

  try {
    const result = await request('read', {
      serviceUuid: characteristic.rawServiceUuid,
      characteristicUuid: characteristic.rawUuid
    });
    updateCharacteristic(result.serviceUuid, result.characteristicUuid, {
      lastValueHex: result.valueHex,
      lastValueAscii: result.valueAscii
    });
    pushLog('rx', 'Read OK', `${result.characteristicUuid}, ${result.byteLength} B`, result.valueHex);
  } catch (error) {
    pushLog('error', 'Read failed', error.message);
  }
}

async function writeSelected() {
  const characteristic = selectedCharacteristic();
  if (!characteristic || !canWrite(characteristic)) return;

  try {
    const result = await request('write', {
      serviceUuid: characteristic.rawServiceUuid,
      characteristicUuid: characteristic.rawUuid,
      mode: state.payloadMode,
      payload: state.payload,
      withoutResponse: state.writeWithoutResponse
    });
    pushLog('tx', 'Write OK', `${result.characteristicUuid}, ${result.byteLength} B`, result.valueHex);
  } catch (error) {
    pushLog('error', 'Write failed', error.message);
  }
}

async function toggleNotify() {
  const characteristic = selectedCharacteristic();
  if (!characteristic || !canNotify(characteristic)) return;

  const method = characteristic.notifying ? 'unsubscribe' : 'subscribe';
  try {
    const result = await request(method, {
      serviceUuid: characteristic.rawServiceUuid,
      characteristicUuid: characteristic.rawUuid
    });
    updateCharacteristic(result.serviceUuid, result.characteristicUuid, {
      notifying: method === 'subscribe'
    });
    pushLog('notify', method === 'subscribe' ? 'Notify enabled' : 'Notify disabled', result.characteristicUuid);
  } catch (error) {
    pushLog('error', 'Notify failed', error.message);
  }
}

app.addEventListener('input', event => {
  if (event.target.matches('[data-field]')) {
    updateFromInputs();
  }
});

app.addEventListener('change', event => {
  if (event.target.matches('[data-field]')) {
    updateFromInputs();
    render();
  }
});

app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  updateFromInputs();
  const action = target.dataset.action;
  const id = target.dataset.id;

  if (action === 'reconnect') connectWs();
  if (action === 'clear-devices') {
    state.devices = [];
    render();
  }
  if (action === 'clear-logs') {
    state.logs = [];
    render();
  }
  if (action === 'start-scan') void startScan();
  if (action === 'stop-scan') void stopScan();
  if (action === 'select-device') {
    state.selectedDeviceId = id;
    render();
  }
  if (action === 'connect-device') void connectDevice(id);
  if (action === 'disconnect') void disconnectDevice();
  if (action === 'refresh-gatt') void refreshGatt();
  if (action === 'select-characteristic') {
    state.selectedServiceUuid = target.dataset.service;
    state.selectedCharacteristicUuid = target.dataset.characteristic;
    render();
  }
  if (action === 'read-selected') void readSelected();
  if (action === 'write-selected') void writeSelected();
  if (action === 'toggle-notify') void toggleNotify();
});

window.addEventListener('beforeunload', () => {
  if (ws) ws.close();
});

render();
connectWs();
