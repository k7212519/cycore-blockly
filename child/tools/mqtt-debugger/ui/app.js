'use strict';

const app = document.getElementById('app');
const query = new URLSearchParams(window.location.search);
const token = query.get('token') || '';
const host = {
  remote: null,
  context: {
    lang: normalizeLang(query.get('lang') || navigator.language || 'en'),
    theme: normalizeTheme(query.get('theme')),
    platform: 'browser'
  }
};
const i18n = {
  lang: 'en',
  bundle: {}
};
const state = {
  backendStatus: 'connecting',
  backendPid: 0,
  brokerUrl: 'wss://test.mosquitto.org:8081/mqtt',
  clientId: `aily-${Math.random().toString(16).slice(2, 10)}`,
  username: '',
  password: '',
  keepAlive: 60,
  cleanSession: true,
  connectionState: 'disconnected',
  subscribeTopic: '#',
  subscribeQos: 0,
  subscriptions: [],
  publishTopic: 'aily/test',
  publishPayload: '',
  publishRetain: false,
  messages: [],
  logs: []
};

let backendWs = null;
let mqttSocket = null;
let packetId = 1;
let pingTimer = null;
let requestSeq = 0;
let logSeq = 0;
const pendingRequests = new Map();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

document.documentElement.lang = host.context.lang;
applyTheme(host.context.theme);

function normalizeLang(lang) {
  const normalized = String(lang || 'en').toLowerCase().replace(/-/g, '_');
  if (normalized.startsWith('zh_cn') || normalized === 'zh') return 'zh_cn';
  if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
  return normalized || 'en';
}

async function loadI18n(lang) {
  const normalized = normalizeLang(lang);
  const candidates = normalized === 'en' ? ['en'] : [normalized, 'en'];

  for (const candidate of candidates) {
    try {
      const response = await fetch(`/i18n/${candidate}.json`, { cache: 'no-store' });
      if (!response.ok) continue;
      const data = await response.json();
      i18n.lang = candidate;
      i18n.bundle = data.MQTT_DEBUGGER || {};
      document.title = t('TITLE', 'MQTT Debugger');
      render();
      return;
    } catch {
      // Try the fallback language.
    }
  }
}

function t(key, fallback = key) {
  return i18n.bundle[key] || fallback;
}

function normalizeTheme(theme) {
  return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalized;
  document.documentElement.style.colorScheme = normalized;

  let themeLink = document.getElementById('theme-style');
  if (!themeLink) {
    themeLink = document.createElement('link');
    themeLink.id = 'theme-style';
    themeLink.rel = 'stylesheet';
    document.head.appendChild(themeLink);
  }

  const href = `./${normalized}.css`;
  if (themeLink.getAttribute('href') !== href) {
    themeLink.setAttribute('href', href);
  }

  return normalized;
}

async function applyHostContext(context = {}) {
  const lang = normalizeLang(context.lang || host.context.lang);
  const theme = normalizeTheme(context.theme || host.context.theme);
  host.context = {
    ...host.context,
    ...context,
    lang,
    theme
  };
  document.documentElement.lang = lang;
  applyTheme(theme);
  await loadI18n(lang);
}

function connectHost() {
  if (!window.Penpal || !window.parent || window.parent === window) {
    return;
  }

  const messenger = new window.Penpal.WindowMessenger({
    remoteWindow: window.parent,
    allowedOrigins: ['*']
  });

  const connection = window.Penpal.connect({
    messenger,
    methods: {
      setHostContext(context = {}) {
        void applyHostContext(context);
        return { ok: true };
      },
      focusTool() {
        window.focus();
        return { ok: true };
      },
      beforeClose() {
        return {
          canClose: true,
          connected: state.connectionState === 'connected'
        };
      }
    }
  });

  connection.promise
    .then(async remote => {
      host.remote = remote;
      if (typeof remote.getHostContext === 'function') {
        const context = await remote.getHostContext();
        if (context) {
          await applyHostContext(context);
        }
      }
      if (state.backendStatus === 'ready') {
        notifyHostReady();
      }
    })
    .catch(error => {
      pushLog('error', 'Host connection failed', error.message || String(error));
    });
}

function notifyHostReady() {
  if (!host.remote || typeof host.remote.childReady !== 'function') return;
  void host.remote.childReady({
    wsConnected: !!backendWs && backendWs.readyState === WebSocket.OPEN,
    backendStatus: state.backendStatus,
    pid: state.backendPid
  });
}

function notifyHostError(error) {
  if (!host.remote || typeof host.remote.childError !== 'function') return;
  void host.remote.childError({
    message: error?.message || String(error || 'Unknown MQTT debugger error')
  });
}

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

function text(key, fallback = key) {
  return escapeHtml(t(key, fallback));
}

function labelText(label) {
  return escapeHtml(t(label, label));
}

function now() {
  return new Date().toLocaleTimeString();
}

function statusKey() {
  return `STATUS_${state.connectionState.toUpperCase()}`;
}

function isConnected() {
  return state.connectionState === 'connected';
}

function pushLog(type, label, detail = '') {
  state.logs.unshift({
    id: ++logSeq,
    type,
    label,
    detail,
    time: now()
  });
  state.logs = state.logs.slice(0, 120);
  render();
}

function renderSubscriptions() {
  return state.subscriptions.map(topic => `
    <div class="subscription-row">
      <code>${escapeHtml(topic)}</code>
      <button type="button" data-action="unsubscribe-topic" data-topic="${escapeAttr(topic)}" ${isConnected() ? '' : 'disabled'} title="${text('UNSUBSCRIBE', 'Unsubscribe')}">x</button>
    </div>
  `).join('');
}

function renderMessages() {
  return state.messages.map(message => `
    <div class="message-row">
      <div class="message-meta">
        <span class="time">${escapeHtml(message.time)}</span>
        <code>${escapeHtml(message.topic)}</code>
        <span>QoS ${escapeHtml(message.qos)}</span>
        ${message.retain ? `<span>${text('RETAIN', 'Retain')}</span>` : ''}
      </div>
      <pre class="mono">${escapeHtml(message.payload)}</pre>
    </div>
  `).join('');
}

function renderLogs() {
  return state.logs.map(log => `
    <div class="log-row ${escapeAttr(log.type)}">
      <span class="time">${escapeHtml(log.time)}</span>
      <span class="label">${labelText(log.label)}</span>
      ${log.detail ? `<span class="detail mono">${escapeHtml(log.detail)}</span>` : '<span></span>'}
    </div>
  `).join('');
}

function render() {
  app.innerHTML = `
    <section class="panel connection-panel">
      <div class="panel-title">
        <span>${text('CONNECTION', 'Connection')}</span>
        <strong class="status ${escapeAttr(state.connectionState)}">${text(statusKey(), state.connectionState)}</strong>
      </div>
      <div class="connection-grid">
        <label class="field span-2">
          <span>${text('BROKER_URL', 'Broker URL')}</span>
          <input type="text" data-field="brokerUrl" value="${escapeAttr(state.brokerUrl)}" placeholder="wss://broker.example.com:8084/mqtt">
        </label>
        <label class="field">
          <span>${text('CLIENT_ID', 'Client ID')}</span>
          <input type="text" data-field="clientId" value="${escapeAttr(state.clientId)}">
        </label>
        <label class="field">
          <span>${text('KEEP_ALIVE', 'Keep Alive (s)')}</span>
          <input type="number" min="0" max="65535" data-field="keepAlive" value="${escapeAttr(state.keepAlive)}">
        </label>
        <label class="field">
          <span>${text('USERNAME', 'Username')}</span>
          <input type="text" data-field="username" value="${escapeAttr(state.username)}">
        </label>
        <label class="field">
          <span>${text('PASSWORD', 'Password')}</span>
          <input type="password" data-field="password" value="${escapeAttr(state.password)}">
        </label>
        <label class="check-field">
          <input type="checkbox" data-field="cleanSession" ${state.cleanSession ? 'checked' : ''}>
          <span>${text('CLEAN_SESSION', 'Clean Session')}</span>
        </label>
      </div>
      <div class="actions">
        <button type="button" class="primary" data-action="connect" ${state.connectionState === 'connecting' || isConnected() ? 'disabled' : ''}>${text('CONNECT', 'Connect')}</button>
        <button type="button" data-action="disconnect" ${isConnected() ? '' : 'disabled'}>${text('DISCONNECT', 'Disconnect')}</button>
      </div>
    </section>
    <div class="workspace-grid">
      <section class="panel topic-panel">
        <div class="panel-title">${text('SUBSCRIBE', 'Subscribe')}</div>
        <label class="field">
          <span>${text('TOPIC', 'Topic')}</span>
          <input type="text" data-field="subscribeTopic" value="${escapeAttr(state.subscribeTopic)}" placeholder="sensor/#">
        </label>
        <label class="field compact">
          <span>QoS</span>
          <select data-field="subscribeQos">
            <option value="0" ${Number(state.subscribeQos) === 0 ? 'selected' : ''}>0</option>
            <option value="1" ${Number(state.subscribeQos) === 1 ? 'selected' : ''}>1</option>
          </select>
        </label>
        <div class="actions">
          <button type="button" class="primary" data-action="subscribe" ${isConnected() ? '' : 'disabled'}>${text('SUBSCRIBE', 'Subscribe')}</button>
          <button type="button" data-action="unsubscribe" ${isConnected() ? '' : 'disabled'}>${text('UNSUBSCRIBE', 'Unsubscribe')}</button>
        </div>
        <div class="subscription-list">${renderSubscriptions()}</div>
      </section>
      <section class="panel publish-panel">
        <div class="panel-title">${text('PUBLISH', 'Publish')}</div>
        <label class="field">
          <span>${text('TOPIC', 'Topic')}</span>
          <input type="text" data-field="publishTopic" value="${escapeAttr(state.publishTopic)}" placeholder="sensor/data">
        </label>
        <label class="field grow">
          <span>${text('PAYLOAD', 'Payload')}</span>
          <textarea class="mono" data-field="publishPayload">${escapeHtml(state.publishPayload)}</textarea>
        </label>
        <div class="publish-footer">
          <label class="check-field">
            <input type="checkbox" data-field="publishRetain" ${state.publishRetain ? 'checked' : ''}>
            <span>${text('RETAIN', 'Retain')}</span>
          </label>
          <button type="button" class="primary" data-action="publish" ${isConnected() ? '' : 'disabled'}>${text('PUBLISH', 'Publish')}</button>
        </div>
      </section>
      <section class="panel messages-panel">
        <div class="panel-title">
          <span>${text('MESSAGES', 'Messages')}</span>
          <button type="button" class="icon-action" data-action="clear-messages" title="${text('CLEAR', 'Clear')}">x</button>
        </div>
        <div class="message-list">${renderMessages()}</div>
      </section>
      <section class="panel logs-panel">
        <div class="panel-title">
          <span>${text('LOG', 'Log')}</span>
          <button type="button" class="icon-action" data-action="clear-logs" title="${text('CLEAR', 'Clear')}">x</button>
        </div>
        <div class="log-list">${renderLogs()}</div>
      </section>
    </div>
  `;
}

function updateFromInputs() {
  for (const element of app.querySelectorAll('[data-field]')) {
    const field = element.dataset.field;
    if (!field) continue;
    if (element.type === 'checkbox') {
      state[field] = element.checked;
    } else if (element.type === 'number') {
      state[field] = Number(element.value);
    } else if (field === 'subscribeQos') {
      state[field] = Number(element.value);
    } else {
      state[field] = element.value;
    }
  }
}

function bytes(values) {
  return new Uint8Array(values);
}

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encodeString(value) {
  const encoded = textEncoder.encode(value);
  return concat(bytes([(encoded.length >> 8) & 0xff, encoded.length & 0xff]), encoded);
}

function readString(data, offset) {
  const length = (data[offset] << 8) | data[offset + 1];
  const start = offset + 2;
  const end = start + length;
  return {
    value: textDecoder.decode(data.slice(start, end)),
    offset: end
  };
}

function encodeRemainingLength(length) {
  const encoded = [];
  let value = length;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 128;
    encoded.push(byte);
  } while (value > 0);
  return bytes(encoded);
}

function decodeRemainingLength(data) {
  let multiplier = 1;
  let value = 0;
  let offset = 1;
  let encodedByte = 0;
  do {
    encodedByte = data[offset] || 0;
    value += (encodedByte & 127) * multiplier;
    multiplier *= 128;
    offset += 1;
  } while ((encodedByte & 128) !== 0 && offset < data.length);
  return { length: value, offset };
}

function nextPacketId() {
  const next = packetId;
  packetId += 1;
  if (packetId > 65535) {
    packetId = 1;
  }
  return next;
}

function isSocketOpen() {
  return mqttSocket?.readyState === WebSocket.OPEN;
}

function sendPacket(packet) {
  if (!isSocketOpen()) {
    pushLog('error', 'SOCKET_NOT_CONNECTED');
    return;
  }
  mqttSocket.send(packet);
}

function sendControlPacket(header, body) {
  sendPacket(concat(bytes([header]), encodeRemainingLength(body.length), body));
}

function sendConnectPacket() {
  const flags =
    (state.username.trim() ? 0x80 : 0) |
    (state.password ? 0x40 : 0) |
    (state.cleanSession ? 0x02 : 0);

  const keepAlive = Math.max(0, Math.min(65535, Number(state.keepAlive) || 0));
  const variableHeader = concat(
    encodeString('MQTT'),
    bytes([0x04, flags, (keepAlive >> 8) & 0xff, keepAlive & 0xff])
  );

  const payloadParts = [encodeString(state.clientId.trim())];
  if (state.username.trim()) {
    payloadParts.push(encodeString(state.username.trim()));
  }
  if (state.password) {
    payloadParts.push(encodeString(state.password));
  }

  sendControlPacket(0x10, concat(variableHeader, ...payloadParts));
  pushLog('out', 'CONNECT_SENT', state.clientId.trim());
}

function handlePacket(data) {
  if (data.length < 2) {
    pushLog('error', 'INVALID_PACKET');
    return;
  }

  const packetType = data[0] >> 4;
  const remaining = decodeRemainingLength(data);
  const bodyStart = remaining.offset;
  const bodyEnd = Math.min(data.length, bodyStart + remaining.length);

  switch (packetType) {
    case 2:
      handleConnack(data, bodyStart);
      break;
    case 3:
      handlePublish(data, bodyStart, bodyEnd);
      break;
    case 9:
      pushLog('in', 'SUBACK_RECEIVED');
      break;
    case 11:
      pushLog('in', 'UNSUBACK_RECEIVED');
      break;
    case 13:
      pushLog('in', 'PINGRESP_RECEIVED');
      break;
    default:
      pushLog('in', 'PACKET_RECEIVED', `type=${packetType}`);
      break;
  }
}

function handleConnack(data, offset) {
  const returnCode = data[offset + 1];
  if (returnCode === 0) {
    state.connectionState = 'connected';
    pushLog('in', 'CONNECTED');
    startPing();
    render();
    return;
  }

  state.connectionState = 'disconnected';
  pushLog('error', 'CONNACK_FAILED', String(returnCode));
  closeMqttSocket(false);
}

function handlePublish(data, offset, end) {
  const flags = data[0] & 0x0f;
  const qos = (flags & 0x06) >> 1;
  const retain = (flags & 0x01) === 0x01;
  const topicResult = readString(data, offset);
  let cursor = topicResult.offset;
  let incomingPacketId = 0;

  if (qos > 0) {
    incomingPacketId = (data[cursor] << 8) | data[cursor + 1];
    cursor += 2;
  }

  const payload = textDecoder.decode(data.slice(cursor, end));
  state.messages.unshift({
    time: now(),
    topic: topicResult.value,
    payload,
    qos,
    retain
  });
  state.messages = state.messages.slice(0, 100);
  pushLog('in', 'MESSAGE_RECEIVED', topicResult.value);

  if (qos === 1 && incomingPacketId > 0) {
    sendPacket(bytes([0x40, 0x02, (incomingPacketId >> 8) & 0xff, incomingPacketId & 0xff]));
  }
}

function startPing() {
  stopPing();
  const keepAlive = Math.max(0, Number(state.keepAlive) || 0);
  if (!keepAlive) return;

  const intervalMs = Math.max(10000, Math.floor(keepAlive * 1000 / 2));
  pingTimer = setInterval(() => {
    if (isConnected()) {
      sendPacket(bytes([0xc0, 0x00]));
      pushLog('out', 'PINGREQ_SENT');
    }
  }, intervalMs);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function connectMqtt() {
  const url = state.brokerUrl.trim();
  if (!/^wss?:\/\//i.test(url)) {
    pushLog('error', 'INVALID_WS_URL');
    return;
  }

  const clientId = state.clientId.trim();
  if (!clientId) {
    pushLog('error', 'CLIENT_ID_REQUIRED');
    return;
  }

  closeMqttSocket(false);
  state.connectionState = 'connecting';
  pushLog('system', 'CONNECTING', url);

  try {
    const socket = new WebSocket(url, ['mqtt']);
    socket.binaryType = 'arraybuffer';
    mqttSocket = socket;

    socket.addEventListener('open', () => {
      sendConnectPacket();
    });
    socket.addEventListener('message', async event => {
      if (event.data instanceof ArrayBuffer) {
        handlePacket(new Uint8Array(event.data));
      } else if (event.data instanceof Blob) {
        const buffer = await event.data.arrayBuffer();
        handlePacket(new Uint8Array(buffer));
      } else {
        pushLog('error', 'UNSUPPORTED_PACKET', String(event.data));
      }
    });
    socket.addEventListener('error', () => {
      pushLog('error', 'SOCKET_ERROR');
    });
    socket.addEventListener('close', event => {
      stopPing();
      state.connectionState = 'disconnected';
      pushLog('system', 'DISCONNECTED', `${event.code} ${event.reason}`.trim());
      if (mqttSocket === socket) {
        mqttSocket = null;
      }
    });
  } catch (error) {
    state.connectionState = 'disconnected';
    pushLog('error', error.message || 'SOCKET_ERROR');
  }
}

function disconnectMqtt() {
  if (isSocketOpen()) {
    sendPacket(bytes([0xe0, 0x00]));
    pushLog('out', 'DISCONNECT_SENT');
  }
  closeMqttSocket();
}

function closeMqttSocket(pushDisconnectedLog = true) {
  stopPing();
  const socket = mqttSocket;
  mqttSocket = null;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    socket.close();
  }

  state.connectionState = 'disconnected';
  if (pushDisconnectedLog) {
    pushLog('system', 'DISCONNECTED');
  } else {
    render();
  }
}

function subscribe() {
  const topic = state.subscribeTopic.trim();
  if (!isConnected() || !topic) return;

  const id = nextPacketId();
  const body = concat(
    bytes([(id >> 8) & 0xff, id & 0xff]),
    encodeString(topic),
    bytes([Number(state.subscribeQos) & 0x01])
  );

  sendControlPacket(0x82, body);
  if (!state.subscriptions.includes(topic)) {
    state.subscriptions = [topic, ...state.subscriptions].slice(0, 20);
  }
  pushLog('out', 'SUBSCRIBE_SENT', topic);
}

function unsubscribe(topic = state.subscribeTopic) {
  const nextTopic = String(topic || '').trim();
  if (!isConnected() || !nextTopic) return;

  const id = nextPacketId();
  const body = concat(
    bytes([(id >> 8) & 0xff, id & 0xff]),
    encodeString(nextTopic)
  );

  sendControlPacket(0xa2, body);
  state.subscriptions = state.subscriptions.filter(item => item !== nextTopic);
  pushLog('out', 'UNSUBSCRIBE_SENT', nextTopic);
}

function publish() {
  const topic = state.publishTopic.trim();
  if (!isConnected() || !topic) return;

  const topicBytes = encodeString(topic);
  const payloadBytes = textEncoder.encode(state.publishPayload);
  const header = 0x30 | (state.publishRetain ? 0x01 : 0);
  sendControlPacket(header, concat(topicBytes, payloadBytes));
  pushLog('out', 'PUBLISH_SENT', topic);
}

function request(method, params = {}, timeoutMs = 15000) {
  if (!backendWs || backendWs.readyState !== WebSocket.OPEN) {
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

  backendWs.send(payload);
  return response;
}

function handleBackendMessage(raw) {
  const message = JSON.parse(raw);
  if (typeof message.id === 'number') {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || 'MQTT debugger request failed'));
    }
    return;
  }

  if (message.event === 'ready') {
    state.backendStatus = 'ready';
    state.backendPid = Number(message.data?.pid) || 0;
    notifyHostReady();
  }
}

function connectBackend() {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Backend reconnecting'));
  }
  pendingRequests.clear();

  if (backendWs) {
    backendWs.close();
    backendWs = null;
  }

  state.backendStatus = 'connecting';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  backendWs = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

  backendWs.addEventListener('open', async () => {
    try {
      const status = await request('status');
      state.backendStatus = 'ready';
      state.backendPid = Number(status.pid) || state.backendPid;
      notifyHostReady();
    } catch (error) {
      state.backendStatus = 'error';
      notifyHostError(error);
    }
  });

  backendWs.addEventListener('message', event => {
    try {
      handleBackendMessage(event.data);
    } catch (error) {
      notifyHostError(error);
    }
  });

  backendWs.addEventListener('close', () => {
    if (state.backendStatus !== 'error') {
      state.backendStatus = 'closed';
    }
  });

  backendWs.addEventListener('error', () => {
    state.backendStatus = 'error';
    notifyHostError(new Error('Backend WebSocket connection failed'));
  });
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

  if (action === 'connect') connectMqtt();
  if (action === 'disconnect') disconnectMqtt();
  if (action === 'subscribe') subscribe();
  if (action === 'unsubscribe') unsubscribe();
  if (action === 'unsubscribe-topic') unsubscribe(target.dataset.topic);
  if (action === 'publish') publish();
  if (action === 'clear-messages') {
    state.messages = [];
    render();
  }
  if (action === 'clear-logs') {
    state.logs = [];
    render();
  }
});

window.addEventListener('beforeunload', () => {
  if (backendWs) backendWs.close();
  closeMqttSocket(false);
});

render();
void loadI18n(host.context.lang);
connectHost();
connectBackend();
