'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const { asError, createMqttDebuggerCore } = require('./core');

const TOOL_ID = 'mqtt-debugger';
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function safeStaticPath(uiRoot, requestPath) {
  const pathname = requestPath === '/' ? '/index.html' : requestPath;
  const decoded = decodeURIComponent(pathname);
  const resolvedRoot = path.resolve(uiRoot);
  const resolvedFile = path.resolve(path.join(resolvedRoot, decoded));
  const relative = path.relative(resolvedRoot, resolvedFile);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }

  return resolvedFile;
}

function i18nPathFromRequest(requestPath) {
  const match = requestPath.match(new RegExp(`^/(?:tools/${TOOL_ID}/)?i18n/([a-zA-Z0-9_-]+\\.json)$`));
  if (!match) return '';
  return path.join(__dirname, 'i18n', match[1]);
}

function serveStatic(uiRoot, request, response) {
  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  if (requestUrl.pathname === '/vendor/penpal.min.js') {
    serveFile(path.join(__dirname, 'node_modules', 'penpal', 'dist', 'penpal.min.js'), response);
    return;
  }

  const fontPath = fontPathFromRequest(requestUrl.pathname);
  if (fontPath) {
    serveFile(fontPath, response);
    return;
  }

  const i18nPath = i18nPathFromRequest(requestUrl.pathname);
  if (i18nPath) {
    serveFile(i18nPath, response);
    return;
  }

  const filePath = safeStaticPath(uiRoot, requestUrl.pathname);
  if (!filePath) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  serveFile(filePath, response);
}

function fontPathFromRequest(requestPath) {
  if (!requestPath.startsWith('/fonts/')) return '';

  const decoded = decodeURIComponent(requestPath.replace(/^\/fonts\//, ''));
  if (decoded.includes('\0')) return '';

  const candidates = [
    path.join(__dirname, 'ui', 'fonts'),
    path.resolve(__dirname, '..', '..', '..', 'public', 'fonts'),
    process.resourcesPath ? path.join(process.resourcesPath, 'renderer', 'fonts') : ''
  ].filter(Boolean);

  for (const root of candidates) {
    const resolvedRoot = path.resolve(root);
    const resolvedFile = path.resolve(path.join(resolvedRoot, decoded));
    const relative = path.relative(resolvedRoot, resolvedFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (fs.existsSync(resolvedFile)) return resolvedFile;
  }

  return path.join(candidates[0] || __dirname, decoded);
}

function serveFile(filePath, response) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Internal server error');
      return;
    }

    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    response.end(content);
  });
}

function verifyToken(requestUrl, token) {
  return requestUrl.searchParams.get('token') === token;
}

function createRpcMessage(id, ok, result = {}, error = '') {
  return { id, ok, result, error };
}

async function startMqttDebuggerServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number.isFinite(Number(options.port)) ? Number(options.port) : 0;
  const token = options.token || createToken();
  const uiRoot = path.resolve(options.uiRoot || path.join(__dirname, 'ui'));
  const clients = new Set();
  let closing = false;
  let server;

  const core = createMqttDebuggerCore();
  const wss = new WebSocketServer({ noServer: true });

  async function stop() {
    if (closing) return;
    closing = true;

    await core.shutdown().catch(() => undefined);
    for (const client of clients) {
      client.close(1001, 'MQTT debugger server closed');
    }

    await new Promise(resolve => {
      wss.close(() => resolve());
      if (server) {
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async function handleRpc(socket, message) {
    const id = message.id;
    const method = message.method || message.action;

    try {
      const result = await core.executeAction({
        action: method,
        params: message.params || message.data || {}
      });
      socket.send(JSON.stringify(createRpcMessage(id, true, result)));
      if (method === 'shutdown') {
        await stop();
      }
    } catch (error) {
      socket.send(JSON.stringify(createRpcMessage(id, false, {}, asError(error))));
    }
  }

  wss.on('connection', socket => {
    clients.add(socket);
    socket.send(JSON.stringify({
      event: 'ready',
      data: {
        state: core.status().state,
        pid: process.pid
      }
    }));

    socket.on('message', data => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch (error) {
        socket.send(JSON.stringify({ ok: false, error: asError(error) }));
        return;
      }
      void handleRpc(socket, message);
    });

    socket.on('close', () => {
      clients.delete(socket);
    });
  });

  server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${host}`);

    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {});
      return;
    }

    if (requestUrl.pathname === '/health') {
      sendJson(response, 200, { ok: true, state: core.status().state });
      return;
    }

    if (requestUrl.pathname === '/api/shutdown') {
      if (!verifyToken(requestUrl, token)) {
        sendJson(response, 403, { ok: false, error: 'Invalid token' });
        return;
      }
      sendJson(response, 200, { ok: true });
      void stop();
      return;
    }

    serveStatic(uiRoot, request, response);
  });

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url, `http://${host}`);
    if (requestUrl.pathname !== '/ws' || !verifyToken(requestUrl, token)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const origin = `http://${host}:${actualPort}`;
  const url = `${origin}/?token=${encodeURIComponent(token)}`;

  return {
    core,
    host,
    port: actualPort,
    token,
    origin,
    url,
    wsUrl: `ws://${host}:${actualPort}/ws?token=${encodeURIComponent(token)}`,
    shutdownUrl: `${origin}/api/shutdown?token=${encodeURIComponent(token)}`,
    stop
  };
}

module.exports = {
  startMqttDebuggerServer
};
