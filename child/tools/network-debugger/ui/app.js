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
  mode: 'http',
  httpMethod: 'GET',
  httpUrl: '',
  httpHeadersText: '',
  httpBody: '',
  httpTimeout: 10000,
  httpLoading: false,
  responseStatus: '',
  responseDuration: 0,
  responseSize: 0,
  responseBody: '',
  responseHeaders: [],
  httpLogs: [],
  wsUrl: '',
  wsMessage: '',
  wsConnected: false,
  wsLogs: []
};
const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

let backendWs = null;
let externalWs = null;
let requestSeq = 0;
let logSeq = 0;
const pendingRequests = new Map();

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
      i18n.bundle = data.NETWORK_DEBUGGER || {};
      document.title = t('TITLE', 'Network Debugger');
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
          connected: state.wsConnected
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
      pushLog('wsLogs', 'error', 'Host connection failed', error.message || String(error));
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
    message: error?.message || String(error || 'Unknown network debugger error')
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

function attrText(key, fallback = key) {
  return escapeAttr(t(key, fallback));
}

function labelText(label) {
  return escapeHtml(t(label, label));
}

function now() {
  return new Date().toLocaleTimeString();
}

function pushLog(listName, type, label, detail = '') {
  state[listName].unshift({
    id: ++logSeq,
    type,
    label,
    detail,
    time: now()
  });
  state[listName] = state[listName].slice(0, listName === 'httpLogs' ? 80 : 120);
  render();
}

function renderLogList(logs) {
  if (!logs.length) {
    return '';
  }

  return logs.map(log => `
    <div class="log-row ${escapeAttr(log.type)}">
      <span class="time">${escapeHtml(log.time)}</span>
      <span class="label">${labelText(log.label)}</span>
      ${log.detail ? `<span class="detail mono">${escapeHtml(log.detail)}</span>` : '<span></span>'}
    </div>
  `).join('');
}

function renderHeaderRows() {
  return state.responseHeaders.map(header => `
    <div class="header-row">
      <span>${escapeHtml(header.name)}</span>
      <code>${escapeHtml(header.value)}</code>
    </div>
  `).join('');
}

function renderHttp() {
  return `
    <div class="debugger-grid">
      <section class="panel request-panel">
        <div class="panel-title">${text('REQUEST', 'Request')}</div>
        <label class="field">
          <span>${text('METHOD', 'Method')}</span>
          <select data-field="httpMethod">
            ${httpMethods.map(method => `<option value="${method}" ${state.httpMethod === method ? 'selected' : ''}>${method}</option>`).join('')}
          </select>
        </label>
        <label class="field">
          <span>${text('URL', 'URL')}</span>
          <input type="text" data-field="httpUrl" value="${escapeAttr(state.httpUrl)}" placeholder="https://api.example.com/data">
        </label>
        <label class="field">
          <span>${text('HEADERS', 'Headers')}</span>
          <textarea class="mono" data-field="httpHeadersText" rows="5" placeholder="Authorization: Bearer ...">${escapeHtml(state.httpHeadersText)}</textarea>
        </label>
        <label class="field grow">
          <span>${text('BODY', 'Body')}</span>
          <textarea class="mono body-input" data-field="httpBody" rows="8" placeholder='{"hello":"world"}'>${escapeHtml(state.httpBody)}</textarea>
        </label>
        <label class="field compact">
          <span>${text('TIMEOUT', 'Timeout (ms)')}</span>
          <input type="number" min="1000" step="1000" data-field="httpTimeout" value="${escapeAttr(state.httpTimeout)}">
        </label>
        <div class="actions">
          <button type="button" class="primary" data-action="send-http" ${state.httpLoading ? 'disabled' : ''}>${text('SEND', 'Send')}</button>
          <button type="button" data-action="clear-http">${text('CLEAR', 'Clear')}</button>
        </div>
      </section>
      <section class="panel response-panel">
        <div class="panel-title">${text('RESPONSE', 'Response')}</div>
        <div class="metrics">
          <div><span>${text('STATUS', 'Status')}</span><strong>${escapeHtml(state.responseStatus || '-')}</strong></div>
          <div><span>${text('DURATION', 'Duration')}</span><strong>${escapeHtml(state.responseDuration || 0)} ms</strong></div>
          <div><span>${text('SIZE', 'Size')}</span><strong>${escapeHtml(state.responseSize || 0)} B</strong></div>
        </div>
        <div class="result-block">
          <div class="result-title">${text('RESPONSE_BODY', 'Response Body')}</div>
          <pre class="mono">${escapeHtml(state.responseBody)}</pre>
        </div>
        <div class="result-block headers">
          <div class="result-title">${text('RESPONSE_HEADERS', 'Response Headers')}</div>
          <div class="header-list">${renderHeaderRows()}</div>
        </div>
      </section>
      <section class="panel log-panel">
        <div class="panel-title">${text('LOG', 'Log')}</div>
        <div class="log-list">${renderLogList(state.httpLogs)}</div>
      </section>
    </div>
  `;
}

function renderWebSocket() {
  return `
    <div class="debugger-grid websocket-grid">
      <section class="panel request-panel">
        <div class="panel-title">${text('WEBSOCKET', 'WebSocket')}</div>
        <label class="field">
          <span>${text('URL', 'URL')}</span>
          <input type="text" data-field="wsUrl" value="${escapeAttr(state.wsUrl)}" placeholder="wss://echo.websocket.events">
        </label>
        <div class="actions">
          <button type="button" class="primary" data-action="connect-ws" ${state.wsConnected ? 'disabled' : ''}>${text('CONNECT', 'Connect')}</button>
          <button type="button" data-action="disconnect-ws" ${state.wsConnected ? '' : 'disabled'}>${text('DISCONNECT', 'Disconnect')}</button>
        </div>
        <label class="field grow">
          <span>${text('MESSAGE', 'Message')}</span>
          <textarea class="mono body-input" data-field="wsMessage" rows="12">${escapeHtml(state.wsMessage)}</textarea>
        </label>
        <div class="actions">
          <button type="button" class="primary" data-action="send-ws" ${state.wsConnected ? '' : 'disabled'}>${text('SEND', 'Send')}</button>
          <button type="button" data-action="clear-ws">${text('CLEAR', 'Clear')}</button>
        </div>
      </section>
      <section class="panel log-panel wide">
        <div class="panel-title">
          <span>${text('LOG', 'Log')}</span>
          <span class="status ${state.wsConnected ? 'connected' : ''}">
            ${state.wsConnected ? text('CONNECTED', 'Connected') : text('DISCONNECTED', 'Disconnected')}
          </span>
        </div>
        <div class="log-list">${renderLogList(state.wsLogs)}</div>
      </section>
    </div>
  `;
}

function render() {
  app.innerHTML = `
    <div class="mode-tabs">
      <button type="button" data-action="set-mode" data-mode="http" class="${state.mode === 'http' ? 'active' : ''}">${text('HTTP', 'HTTP')}</button>
      <button type="button" data-action="set-mode" data-mode="websocket" class="${state.mode === 'websocket' ? 'active' : ''}">${text('WEBSOCKET', 'WebSocket')}</button>
    </div>
    ${state.mode === 'http' ? renderHttp() : renderWebSocket()}
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
    } else {
      state[field] = element.value;
    }
  }
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
      pending.reject(new Error(message.error || 'Network debugger request failed'));
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

async function sendHttpRequest() {
  const url = state.httpUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    pushLog('httpLogs', 'error', 'INVALID_HTTP_URL');
    return;
  }

  state.httpLoading = true;
  state.responseStatus = '';
  state.responseDuration = 0;
  state.responseSize = 0;
  state.responseBody = '';
  state.responseHeaders = [];
  pushLog('httpLogs', 'request', `${state.httpMethod} ${url}`);

  try {
    const result = await request('http.request', {
      method: state.httpMethod,
      url,
      headersText: state.httpHeadersText,
      body: state.httpBody,
      timeoutMs: state.httpTimeout
    }, Math.max(5000, Number(state.httpTimeout) + 5000));

    state.responseStatus = result.statusLine || '';
    state.responseDuration = result.durationMs || 0;
    state.responseSize = result.size || 0;
    state.responseBody = result.body || '';
    state.responseHeaders = result.headers || [];
    pushLog('httpLogs', 'response', state.responseStatus, `${state.responseDuration} ms`);
  } catch (error) {
    pushLog('httpLogs', 'error', error.message || 'REQUEST_FAILED');
  } finally {
    state.httpLoading = false;
    render();
  }
}

function clearHttp() {
  state.responseStatus = '';
  state.responseDuration = 0;
  state.responseSize = 0;
  state.responseBody = '';
  state.responseHeaders = [];
  state.httpLogs = [];
  render();
}

function connectExternalWs() {
  const url = state.wsUrl.trim();
  if (!/^wss?:\/\//i.test(url)) {
    pushLog('wsLogs', 'error', 'INVALID_WS_URL');
    return;
  }

  closeExternalWs(false);
  pushLog('wsLogs', 'system', 'CONNECTING');

  try {
    externalWs = new WebSocket(url);
    externalWs.addEventListener('open', () => {
      state.wsConnected = true;
      pushLog('wsLogs', 'system', 'CONNECTED');
    });
    externalWs.addEventListener('message', event => {
      pushLog('wsLogs', 'response', 'RECEIVED', formatSocketData(event.data));
    });
    externalWs.addEventListener('error', () => {
      pushLog('wsLogs', 'error', 'WS_ERROR');
    });
    externalWs.addEventListener('close', event => {
      state.wsConnected = false;
      pushLog('wsLogs', 'system', 'DISCONNECTED', `${event.code} ${event.reason}`.trim());
      externalWs = null;
    });
  } catch (error) {
    pushLog('wsLogs', 'error', error.message || 'WS_ERROR');
  }
}

function closeExternalWs(renderAfter = true) {
  if (!externalWs) {
    state.wsConnected = false;
    if (renderAfter) render();
    return;
  }

  const socket = externalWs;
  externalWs = null;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
  state.wsConnected = false;
  if (renderAfter) render();
}

function sendWsMessage() {
  if (!externalWs || externalWs.readyState !== WebSocket.OPEN) {
    pushLog('wsLogs', 'error', 'WS_NOT_CONNECTED');
    return;
  }

  externalWs.send(state.wsMessage);
  pushLog('wsLogs', 'request', 'SENT', state.wsMessage);
}

function formatSocketData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return `ArrayBuffer(${data.byteLength})`;
  if (data instanceof Blob) return `Blob(${data.size})`;
  return String(data);
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

  if (action === 'set-mode') {
    state.mode = target.dataset.mode || 'http';
    render();
  }
  if (action === 'send-http') void sendHttpRequest();
  if (action === 'clear-http') clearHttp();
  if (action === 'connect-ws') connectExternalWs();
  if (action === 'disconnect-ws') closeExternalWs();
  if (action === 'send-ws') sendWsMessage();
  if (action === 'clear-ws') {
    state.wsLogs = [];
    render();
  }
});

window.addEventListener('beforeunload', () => {
  if (backendWs) backendWs.close();
  if (externalWs) externalWs.close();
});

render();
void loadI18n(host.context.lang);
connectHost();
connectBackend();
