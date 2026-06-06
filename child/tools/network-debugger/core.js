'use strict';

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function parseHeadersText(text = '') {
  const headers = {};
  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(`Invalid header format: ${line}`);
    }

    const name = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    headers[name] = value;
  }

  return headers;
}

function normalizeMethod(method) {
  const next = String(method || 'GET').trim().toUpperCase();
  return next || 'GET';
}

function normalizeTimeout(value, fallback = 10000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1000, Math.trunc(parsed));
}

async function sendHttpRequest(options = {}) {
  if (typeof fetch !== 'function') {
    throw new Error('Node fetch API is not available');
  }

  const url = String(options.url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Enter an http:// or https:// URL');
  }

  const method = normalizeMethod(options.method);
  const timeoutMs = normalizeTimeout(options.timeoutMs || options.timeout, 10000);
  const headers = {
    ...parseHeadersText(options.headersText || ''),
    ...(options.headers && typeof options.headers === 'object' ? options.headers : {})
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const requestInit = {
      method,
      headers,
      signal: controller.signal
    };

    if (!['GET', 'HEAD'].includes(method) && options.body !== undefined && String(options.body).length > 0) {
      requestInit.body = String(options.body);
    }

    const response = await fetch(url, requestInit);
    const buffer = Buffer.from(await response.arrayBuffer());
    const responseHeaders = [];
    response.headers.forEach((value, name) => {
      responseHeaders.push({ name, value });
    });

    return {
      method,
      url,
      status: response.status,
      statusText: response.statusText,
      statusLine: `${response.status} ${response.statusText}`.trim(),
      durationMs: Date.now() - startedAt,
      size: buffer.length,
      headers: responseHeaders,
      body: buffer.toString('utf8')
    };
  } finally {
    clearTimeout(timer);
  }
}

function createNetworkDebuggerCore() {
  function status() {
    return {
      state: 'ready',
      pid: process.pid,
      fetchAvailable: typeof fetch === 'function'
    };
  }

  async function executeAction(message = {}) {
    const action = message.action || message.method;
    const params = message.params || message.data || message;

    switch (action) {
      case 'status':
        return status();
      case 'http.request':
      case 'request':
        return await sendHttpRequest(params);
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
    sendHttpRequest,
    executeAction,
    shutdown,
    cleanup
  };
}

module.exports = {
  asError,
  createNetworkDebuggerCore,
  parseHeadersText,
  sendHttpRequest
};
