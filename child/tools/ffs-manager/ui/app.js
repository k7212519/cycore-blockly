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

const BAUDRATES = [115200, 230400, 460800, 921600, 1500000, 2000000];
const SELF_SIGNAL_SOURCE = 'child-tool:ffs-manager-child';
const DEFAULT_BLOCK_SIZE = 4096;
const SPIFFS_PAGE_SIZE = 256;
const BLOCK_SIZE_CANDIDATES = [4096, 2048, 1024, 512];
const FAT_MOUNT = '/fatfs';
const FILE_NAME_MAX_BYTES = {
  spiffs: 30,
  littlefs: 63,
  fatfs: 255
};
const FILESYSTEM_LABELS = {
  spiffs: 'SPIFFS',
  littlefs: 'LittleFS',
  fatfs: 'FATFS'
};

const fsContent = createFilesystemContent();
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

const state = {
  backendStatus: 'connecting',
  backendPid: 0,
  ports: [],
  portPath: '',
  baudRate: 921600,
  busy: false,
  statusText: '',
  filesystemStatusText: '',
  errorText: '',
  noticeText: '',
  deviceInfo: null,
  partitions: [],
  selectedPartitionIndex: -1,
  filesystemSession: null,
  filesystemDirty: false,
  currentPath: '/',
  selectedFilePath: '',
  uploadRestorePort: '',
  progressPercent: 0,
  modal: null
};

let backendWs = null;
let requestSeq = 0;
let pendingRequests = new Map();

document.documentElement.lang = host.context.lang;
applyTheme(host.context.theme);

function normalizeLang(lang) {
  const normalized = String(lang || 'en').toLowerCase().replace(/-/g, '_');
  if (normalized === 'zh' || normalized.startsWith('zh_cn')) return 'zh_cn';
  if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
  return normalized || 'en';
}

function normalizeTheme(theme) {
  return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalized;
  document.documentElement.style.colorScheme = normalized;
  const themeLink = document.getElementById('theme-style');
  if (themeLink) themeLink.setAttribute('href', `./${normalized}.css`);
  return normalized;
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
      i18n.bundle = data.FFS_MANAGER || {};
      document.title = t('CHILD_TITLE', t('TITLE', 'FFS Manager'));
      state.statusText ||= t('STATUS.SELECT_PORT_REFRESH', 'Select an ESP32 serial port to refresh device info');
      state.filesystemStatusText ||= t('STATUS.FILESYSTEM_READY_HINT', 'Read the file list before managing partition contents');
      render();
      return;
    } catch {
      // Continue to fallback language.
    }
  }
}

function t(key, fallback = key, params = {}) {
  const value = key.split('.').reduce((current, part) => current?.[part], i18n.bundle) || fallback;
  return String(value).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => params[name] ?? '');
}

function text(key, fallback = key, params = {}) {
  return escapeHtml(t(key, fallback, params));
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function connectHost() {
  if (!window.Penpal || !window.parent || window.parent === window) return;
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
          canClose: !state.busy,
          connected: !!state.deviceInfo
        };
      },
      handleToolSignal(action = {}) {
        return handleHostToolSignal(action);
      }
    }
  });

  connection.promise
    .then(async remote => {
      host.remote = remote;
      if (typeof remote.getHostContext === 'function') {
        const context = await remote.getHostContext();
        if (context) await applyHostContext(context);
      }
      notifyHostReady();
    })
    .catch(error => {
      state.errorText = error.message || String(error);
      render();
    });
}

async function applyHostContext(context = {}) {
  const lang = normalizeLang(context.lang || host.context.lang);
  const theme = normalizeTheme(context.theme || host.context.theme);
  host.context = { ...host.context, ...context, lang, theme };
  document.documentElement.lang = lang;
  applyTheme(theme);
  await loadI18n(lang);
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
    message: error?.message || String(error || 'FFS manager error')
  });
}

async function sendHostToolSignal(signal, payload = {}) {
  if (!host.remote || typeof host.remote.sendToolSignal !== 'function') {
    if (signal === 'serial-monitor:disconnect') await sleep(300);
    return { ok: false, skipped: true };
  }

  return await host.remote.sendToolSignal(signal, {
    portType: 'serial',
    source: SELF_SIGNAL_SOURCE,
    ...payload
  });
}

async function requestSerialOwnerRelease(port) {
  if (!port) return;
  await sendHostToolSignal('serial-monitor:disconnect', { port, portType: 'serial' });
}

async function requestSerialOwnerRestore(port) {
  if (!port) return;
  await sendHostToolSignal('serial-monitor:connect', { port, portType: 'serial' });
}

async function handleHostToolSignal(action = {}) {
  if (action?.action !== 'signal' || action?.type !== 'tool') return { ok: true, skipped: true };
  const payload = action.payload || {};
  if (payload.source === SELF_SIGNAL_SOURCE) return { ok: true, skipped: true };

  const signal = action.data;
  const port = payload.port || state.portPath;
  if (signal === 'serial-monitor:disconnect') {
    await pauseForExternalSerialUse(port);
    return { ok: true };
  }
  if (signal === 'serial-monitor:connect') {
    void restoreAfterExternalSerialUse(port);
    return { ok: true };
  }

  return { ok: true, skipped: true };
}

async function pauseForExternalSerialUse(port) {
  if (!port || !state.deviceInfo || state.portPath !== port) return;

  state.uploadRestorePort = port;
  state.busy = true;
  state.statusText = t('STATUS.PAUSED_FOR_UPLOAD', 'Paused for upload');
  state.filesystemStatusText = t('STATUS.CANCELLING', 'Cancelling...');
  render();

  try {
    await rpc('session.release', { hardReset: true });
    await rpc('port.waitReady', { port, timeoutMs: 4000 }).catch(() => undefined);
  } catch (error) {
    console.warn('[FfsManager] release before external serial use failed:', error);
  }

  state.deviceInfo = null;
  state.partitions = [];
  state.selectedPartitionIndex = -1;
  resetFilesystemState();
  state.busy = false;
  render();
}

async function restoreAfterExternalSerialUse(port) {
  if (!port || state.uploadRestorePort !== port || state.deviceInfo || state.busy) return;

  state.uploadRestorePort = '';
  state.portPath = port;
  state.statusText = t('STATUS.RECONNECTING_AFTER_UPLOAD', 'Reconnecting after upload...');
  render();
  await refreshAll({ coordinateSerial: false });
}

function wsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
}

function connectBackend() {
  backendWs = new WebSocket(wsUrl());
  backendWs.addEventListener('open', () => {
    state.backendStatus = 'ready';
    render();
    notifyHostReady();
    void loadPorts();
  });
  backendWs.addEventListener('message', event => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleBackendMessage(message);
  });
  backendWs.addEventListener('close', () => {
    state.backendStatus = 'closed';
    render();
  });
  backendWs.addEventListener('error', () => {
    state.backendStatus = 'error';
    state.errorText = 'Backend WebSocket error';
    render();
    notifyHostError(new Error(state.errorText));
  });
}

function handleBackendMessage(message) {
  if (message.id && pendingRequests.has(message.id)) {
    const pending = pendingRequests.get(message.id);
    pendingRequests.delete(message.id);
    if (message.ok) pending.resolve(message.result || {});
    else pending.reject(new Error(message.error || 'Request failed'));
    return;
  }

  if (message.event === 'ready') {
    state.backendPid = Number(message.data?.pid || 0);
    notifyHostReady();
    render();
    return;
  }

  if (message.event === 'progress') {
    const done = Number(message.data?.done || 0);
    const total = Number(message.data?.total || 0);
    state.progressPercent = total ? Math.min(100, Math.floor(done / total * 100)) : 0;
    const prefix = message.data?.kind === 'write'
      ? t('STATUS.WRITING_FILESYSTEM_IMAGE', 'Writing filesystem image back')
      : state.filesystemStatusText || state.statusText;
    const detail = `${prefix} ${state.progressPercent}%, ${formatBytes(done)} / ${formatBytes(total)}`;
    if (message.data?.kind === 'write') state.filesystemStatusText = detail;
    else state.filesystemStatusText = detail;
    render();
  }
}

function rpc(method, params = {}) {
  if (!backendWs || backendWs.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Backend is not connected'));
  }
  const id = ++requestSeq;
  const payload = { id, method, params };
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    backendWs.send(JSON.stringify(payload));
  });
}

async function loadPorts() {
  try {
    const result = await rpc('serial.list');
    state.ports = result.ports || [];
    if (!state.portPath && state.ports.length === 1) state.portPath = state.ports[0].path;
    render();
  } catch (error) {
    setError(error);
  }
}

function selectedPartition() {
  return state.partitions[state.selectedPartitionIndex] || null;
}

function filesystemPartitions() {
  return state.partitions.filter(partition => partition.filesystemType);
}

async function refreshAll(options = {}) {
  const coordinateSerial = options.coordinateSerial !== false;
  if (!state.portPath) {
    state.noticeText = t('STATUS.SELECT_PORT_FIRST', 'Please select a serial port first');
    render();
    return;
  }

  state.busy = true;
  state.errorText = '';
  state.noticeText = '';
  state.statusText = t('STATUS.READING_DEVICE_INFO', 'Reading device info...');
  resetFilesystemState();
  render();

  try {
    if (coordinateSerial) {
      await requestSerialOwnerRelease(state.portPath);
    }

    state.deviceInfo = await rpc('device.readInfo', {
      port: state.portPath,
      baudRate: state.baudRate
    });
    state.statusText = t('STATUS.READING_PARTITION_TABLE', 'Reading partition table...');
    render();
    const table = await rpc('partition.readTable', {
      port: state.portPath,
      baudRate: state.baudRate
    });
    state.partitions = table.partitions || [];
    const fsIndex = state.partitions.findIndex(partition => partition.filesystemType);
    state.selectedPartitionIndex = fsIndex >= 0 ? fsIndex : (state.partitions.length ? 0 : -1);
    state.statusText = state.partitions.length
      ? t('STATUS.PARTITIONS_READ', 'Read {{total}} partitions, including {{filesystem}} filesystem partitions', {
        total: state.partitions.length,
        filesystem: filesystemPartitions().length
      })
      : t('STATUS.NO_PARTITION_TABLE', 'No partition table was read');
    render();
  } catch (error) {
    try { await rpc('session.release', { hardReset: true }); } catch {}
    try { await rpc('port.waitReady', { port: state.portPath, timeoutMs: 3000 }); } catch {}
    if (coordinateSerial) {
      await requestSerialOwnerRestore(state.portPath);
    }
    setError(error, t('STATUS.READ_FAILED', 'Read failed'));
  } finally {
    state.busy = false;
    render();
  }

  if (!state.errorText && selectedPartition()?.filesystemType) {
    await loadFilesystemContent();
  }
}

async function releaseSession(hardReset = true) {
  const releasedPort = state.portPath;
  state.busy = true;
  state.statusText = t('STATUS.CANCELLING', 'Cancelling...');
  render();
  try {
    await rpc('session.release', { hardReset });
    state.deviceInfo = null;
    state.partitions = [];
    state.selectedPartitionIndex = -1;
    resetFilesystemState();
    state.statusText = t('STATUS.DISCONNECTED', 'Disconnected');
    await rpc('port.waitReady', { port: releasedPort, timeoutMs: 3000 }).catch(() => undefined);
    await requestSerialOwnerRestore(releasedPort);
  } catch (error) {
    setError(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function selectPartitionByIndex(index) {
  if (state.selectedPartitionIndex === index) return;
  if (state.filesystemDirty && !confirm(t('DIALOGS.SWITCH_PARTITION_CONTENT', 'The current filesystem has unwritten changes. Switching partitions will discard them. Continue?'))) {
    return;
  }
  state.selectedPartitionIndex = index;
  resetFilesystemState();
  render();
}

async function loadFilesystemContent() {
  const partition = selectedPartition();
  if (!partition?.filesystemType || !state.portPath) return;

  state.busy = true;
  state.errorText = '';
  state.progressPercent = 0;
  const partitionName = getPartitionDisplayName(partition);
  state.filesystemStatusText = t('STATUS.READING_FILESYSTEM', 'Reading {{partition}} filesystem...', { partition: partitionName });
  render();

  try {
    const operationId = `read-${Date.now()}`;
    const result = await rpc('partition.readImage', {
      operationId,
      port: state.portPath,
      baudRate: state.baudRate,
      partition
    });
    const image = base64ToBytes(result.base64 || '');
    state.filesystemSession = await fsContent.mountPartition(partition, image);
    await refreshFilesystemSession(false);
    state.filesystemStatusText = t('STATUS.FILESYSTEM_ENTRIES_READ', 'Read {{count}} filesystem entries', {
      count: state.filesystemSession.files.length
    });
    state.noticeText = t('MESSAGES.FILESYSTEM_CONTENT_READ', 'Filesystem content read');
  } catch (error) {
    setError(error, t('STATUS.FILESYSTEM_READ_FAILED', 'Failed to read filesystem'));
  } finally {
    state.busy = false;
    state.progressPercent = 0;
    render();
  }
}

async function refreshFilesystemSession(dirty) {
  const session = state.filesystemSession;
  if (!session) return;
  session.files = await fsContent.listFiles(session);
  session.usage = await fsContent.getUsage(session);
  state.filesystemDirty = dirty;
  state.selectedFilePath = '';
}

async function saveFilesystemContent() {
  const session = state.filesystemSession;
  const partition = selectedPartition();
  if (!session || !partition || !state.portPath) return;
  if (!confirm(t('FILESYSTEM.CONFIRM_WRITE_BACK', 'Write the current image back to the partition?'))) return;

  state.busy = true;
  state.errorText = '';
  state.progressPercent = 0;
  state.filesystemStatusText = t('STATUS.EXPORTING_AND_WRITING', 'Exporting image and writing back to device...');
  render();

  try {
    const image = await fsContent.toImage(session);
    if (image.length !== partition.size) {
      throw new Error(t('ERRORS.IMAGE_SIZE_MISMATCH', 'Exported image size {{imageSize}} does not match partition size {{partitionSize}}', {
        imageSize: formatBytes(image.length),
        partitionSize: partition.sizeText
      }));
    }
    await rpc('partition.writeImage', {
      operationId: `write-${Date.now()}`,
      port: state.portPath,
      baudRate: state.baudRate,
      partition,
      base64: bytesToBase64(image)
    });
    session.image = image;
    state.filesystemDirty = false;
    state.filesystemStatusText = t('STATUS.CONTENT_WRITTEN', 'Filesystem content written back to device');
    state.noticeText = t('MESSAGES.CONTENT_WRITTEN', 'Filesystem content written back to device');
  } catch (error) {
    setError(error, t('STATUS.WRITE_FAILED', 'Write back failed'));
  } finally {
    state.busy = false;
    state.progressPercent = 0;
    render();
  }
}

async function downloadSelectedPartition() {
  const partition = selectedPartition();
  if (!partition?.filesystemType || !state.portPath) return;

  state.busy = true;
  state.errorText = '';
  state.statusText = t('STATUS.EXPORTING_PARTITION', 'Exporting {{partition}}', {
    partition: getPartitionDisplayName(partition)
  });
  render();

  try {
    const result = await rpc('partition.readImage', {
      operationId: `export-${Date.now()}`,
      port: state.portPath,
      baudRate: state.baudRate,
      partition
    });
    downloadBytes(buildPartitionFileName(partition), base64ToBytes(result.base64 || ''), 'application/octet-stream');
    state.statusText = t('STATUS.PARTITION_EXPORTED', 'Partition image exported');
    state.noticeText = t('MESSAGES.PARTITION_EXPORTED', 'Partition image exported');
  } catch (error) {
    setError(error, t('STATUS.EXPORT_FAILED', 'Export failed'));
  } finally {
    state.busy = false;
    render();
  }
}

async function restoreSelectedPartition(file) {
  const partition = selectedPartition();
  if (!file || !partition || !state.portPath) return;
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length !== partition.size) {
    state.noticeText = t('MESSAGES.IMAGE_SIZE_MUST_EQUAL', 'Image size must equal {{size}}', { size: partition.sizeText });
    render();
    return;
  }
  if (!confirm(t('DIALOGS.RESTORE_IMAGE_CONTENT', 'Write {{name}} to partition {{partition}}?', {
    name: file.name,
    partition: getPartitionDisplayName(partition)
  }))) return;

  state.busy = true;
  state.errorText = '';
  state.statusText = t('STATUS.RESTORING_PARTITION', 'Restoring {{partition}}', {
    partition: getPartitionDisplayName(partition)
  });
  render();

  try {
    await rpc('partition.writeImage', {
      operationId: `restore-${Date.now()}`,
      port: state.portPath,
      baudRate: state.baudRate,
      partition,
      base64: bytesToBase64(data)
    });
    state.statusText = t('STATUS.PARTITION_WRITTEN', 'Partition image written');
    state.noticeText = t('MESSAGES.PARTITION_WRITTEN', 'Partition image written');
  } catch (error) {
    setError(error, t('STATUS.RESTORE_FAILED', 'Restore failed'));
  } finally {
    state.busy = false;
    render();
  }
}

async function eraseSelectedPartition() {
  const partition = selectedPartition();
  if (!partition?.filesystemType || !state.portPath) return;
  if (!confirm(t('DIALOGS.ERASE_PARTITION_CONTENT', 'Erase partition {{partition}}? This action cannot be undone.', {
    partition: getPartitionDisplayName(partition)
  }))) return;

  state.busy = true;
  state.errorText = '';
  state.statusText = t('STATUS.ERASING_PARTITION', 'Erasing {{partition}}...', {
    partition: getPartitionDisplayName(partition)
  });
  render();

  try {
    await rpc('partition.erase', {
      port: state.portPath,
      baudRate: state.baudRate,
      partition
    });
    state.statusText = t('STATUS.PARTITION_ERASED', 'Partition erased');
    state.noticeText = t('MESSAGES.PARTITION_ERASED', 'Partition erased');
    resetFilesystemState();
  } catch (error) {
    setError(error, t('STATUS.ERASE_FAILED', 'Erase failed'));
  } finally {
    state.busy = false;
    render();
  }
}

async function uploadFileToFilesystem(file) {
  const session = state.filesystemSession;
  if (!session || !file) return;

  const validationError = fsContent.validateUploadFileName(file.name, session.type);
  if (validationError) {
    state.errorText = validationError;
    state.filesystemStatusText = t('STATUS.UPLOAD_FAILED_NAME_TOO_LONG', 'Upload failed: filename is too long');
    render();
    return;
  }

  state.busy = true;
  state.errorText = '';
  state.filesystemStatusText = t('STATUS.UPLOADING_FILE', 'Uploading {{name}}...', { name: file.name });
  render();

  try {
    const basePath = state.currentPath === '/' ? '' : state.currentPath;
    const uploadPath = `${basePath}/${fsContent.getDefaultUploadFileName(file.name)}`.replace(/\/+/g, '/');
    const data = new Uint8Array(await file.arrayBuffer());
    await fsContent.writeFile(session, uploadPath, data);
    await refreshFilesystemSession(true);
    state.filesystemStatusText = t('STATUS.FILE_ADDED_PENDING', '{{name}} was added to the filesystem and will take effect after writing back to the device', { name: uploadPath });
    state.noticeText = t('MESSAGES.FILE_UPLOADED', 'File uploaded to image');
  } catch (error) {
    setError(error, t('STATUS.UPLOAD_FAILED', 'Upload failed'));
  } finally {
    state.busy = false;
    render();
  }
}

async function deleteFilesystemEntry(path) {
  const session = state.filesystemSession;
  const entry = session?.files.find(item => item.path === path);
  if (!session || !entry) return;
  if (!confirm(t('FILESYSTEM.CONFIRM_DELETE', 'Delete {{type}} {{path}}?', { type: entry.type, path: entry.path }))) return;

  state.busy = true;
  state.filesystemStatusText = t('STATUS.DELETING_ENTRY', 'Deleting {{path}}...', { path: entry.path });
  render();
  try {
    await fsContent.deleteEntry(session, entry);
    await refreshFilesystemSession(true);
    state.filesystemStatusText = t('STATUS.ENTRY_DELETED_PENDING', '{{path}} was deleted and will take effect after writing back to the device', { path: entry.path });
    state.noticeText = t('MESSAGES.ENTRY_DELETED', 'Filesystem entry deleted');
  } catch (error) {
    setError(error, t('STATUS.DELETE_FAILED', 'Delete failed'));
  } finally {
    state.busy = false;
    render();
  }
}

async function renameFilesystemEntry(path) {
  const session = state.filesystemSession;
  const entry = session?.files.find(item => item.path === path);
  if (!session || !entry) return;
  const nextPath = prompt(t('DIALOGS.RENAME_TITLE', 'Rename'), entry.path);
  if (!nextPath || nextPath.trim() === entry.path) return;

  state.busy = true;
  state.filesystemStatusText = t('STATUS.RENAMING_ENTRY', 'Renaming {{path}}...', { path: entry.path });
  render();
  try {
    await fsContent.renameEntry(session, entry, nextPath);
    await refreshFilesystemSession(true);
    state.filesystemStatusText = t('STATUS.ENTRY_RENAMED_PENDING', '{{path}} was renamed and will take effect after writing back to the device', { path: entry.path });
    state.noticeText = t('MESSAGES.ENTRY_RENAMED', 'Filesystem entry renamed');
  } catch (error) {
    setError(error, t('STATUS.RENAME_FAILED', 'Rename failed'));
  } finally {
    state.busy = false;
    render();
  }
}

async function createFilesystemDirectory() {
  const session = state.filesystemSession;
  if (!session) return;
  const base = state.currentPath === '/' ? '' : state.currentPath.replace(/\/$/, '');
  const path = prompt(t('DIALOGS.NEW_FOLDER_TITLE', 'New Folder'), `${base}/new_folder`);
  if (!path?.trim()) return;

  state.busy = true;
  state.filesystemStatusText = t('STATUS.CREATING_DIRECTORY', 'Creating directory {{path}}...', { path });
  render();
  try {
    await fsContent.mkdir(session, path);
    await refreshFilesystemSession(true);
    state.filesystemStatusText = t('STATUS.DIRECTORY_CREATED_PENDING', '{{path}} was created and will take effect after writing back to the device', { path });
    state.noticeText = t('MESSAGES.DIRECTORY_CREATED', 'Directory created');
  } catch (error) {
    setError(error, t('STATUS.CREATE_DIRECTORY_FAILED', 'Failed to create directory'));
  } finally {
    state.busy = false;
    render();
  }
}

async function formatFilesystemContent() {
  const session = state.filesystemSession;
  if (!session || !confirm(t('FILESYSTEM.CONFIRM_FORMAT', 'Format the current filesystem image?'))) return;
  state.busy = true;
  state.filesystemStatusText = t('STATUS.FORMATTING_IMAGE', 'Formatting filesystem image...');
  render();
  try {
    await fsContent.format(session);
    await refreshFilesystemSession(true);
    state.filesystemStatusText = t('STATUS.IMAGE_FORMATTED_PENDING', 'Filesystem image formatted and will take effect after writing back to the device');
    state.noticeText = t('MESSAGES.IMAGE_FORMATTED', 'Filesystem image formatted');
  } catch (error) {
    setError(error, t('STATUS.FORMAT_FAILED', 'Format failed'));
  } finally {
    state.busy = false;
    render();
  }
}

async function downloadFilesystemFile(path) {
  const session = state.filesystemSession;
  const entry = session?.files.find(item => item.path === path);
  if (!session || !entry || entry.type !== 'file') return;
  try {
    const data = await fsContent.readFile(session, entry.path);
    downloadBytes(entry.name || 'file.bin', data, 'application/octet-stream');
    state.noticeText = t('MESSAGES.FILE_DOWNLOADED', 'File downloaded');
    render();
  } catch (error) {
    setError(error, t('STATUS.DOWNLOAD_FAILED', 'Download failed'));
  }
}

async function previewFilesystemFile(path) {
  const session = state.filesystemSession;
  const entry = session?.files.find(item => item.path === path);
  if (!session || !entry || entry.type !== 'file') return;
  try {
    const data = await fsContent.readFile(session, entry.path);
    const mode = getPreviewMode(entry.name);
    if (mode === 'text') {
      const max = 256 * 1024;
      const text = textDecoder.decode(data.slice(0, max));
      const suffix = data.length > max ? `\n\n${t('VIEWER.TRUNCATED', 'Truncated (showing first {{size}})', { size: formatBytes(max) })}` : '';
      state.modal = { title: `${entry.name} · ${formatBytes(data.length)}`, type: 'text', content: `${text}${suffix}` };
    } else if (mode === 'image') {
      const url = URL.createObjectURL(new Blob([toBlobPart(data)]));
      state.modal = { title: `${entry.name} · ${formatBytes(data.length)}`, type: 'image', url };
    } else if (mode === 'audio') {
      const url = URL.createObjectURL(new Blob([toBlobPart(data)]));
      state.modal = { title: `${entry.name} · ${formatBytes(data.length)}`, type: 'audio', url };
    } else {
      state.noticeText = t('STATUS.PREVIEW_UNSUPPORTED', 'Preview is not supported for this file type');
    }
    render();
  } catch (error) {
    setError(error, t('STATUS.FILE_READ_FAILED', 'Read failed'));
  }
}

function closeModal() {
  if (state.modal?.url) URL.revokeObjectURL(state.modal.url);
  state.modal = null;
  render();
}

function resetFilesystemState() {
  state.filesystemSession = null;
  state.filesystemDirty = false;
  state.currentPath = '/';
  state.selectedFilePath = '';
  state.filesystemStatusText = t('STATUS.FILESYSTEM_READY_HINT', 'Read the file list before managing partition contents');
}

function setError(error, statusText = '') {
  state.errorText = error?.message || String(error || t('COMMON.UNKNOWN_ERROR', 'Unknown error'));
  if (statusText) state.statusText = statusText;
  notifyHostError(error);
  render();
}

function render() {
  const partition = selectedPartition();
  const canUseDevice = !!state.portPath && !state.busy;
  const session = state.filesystemSession;
  const displayEntries = session ? getDisplayEntries(session.files, state.currentPath) : [];
  app.innerHTML = `
    <div class="window-box">
      <div class="main-box">
        ${renderSettingsBar(canUseDevice)}
        <div class="content">
          ${renderDevicePanel()}
          ${renderPartitionPanel()}
          ${renderFilesystemManager(partition, session, displayEntries, canUseDevice)}
        </div>
      </div>
    </div>
    ${renderModal()}
  `;
}

function renderSettingsBar(canUseDevice) {
  const selectedPort = state.ports.find(port => port.path === state.portPath);
  const portLabel = state.portPath || t('UNSELECTED', 'Not selected');
  const portDetail = selectedPort?.name && selectedPort.name !== selectedPort.path ? ` ${selectedPort.name}` : '';
  const switchAction = state.deviceInfo ? 'disconnect' : 'refresh';
  const switchLabel = state.deviceInfo
    ? t('STATUS.DISCONNECTED', 'Disconnect')
    : t('STATUS.READING_DEVICE_INFO', 'Connect').replace(/\.\.\.$/, '');

  return `
    <div class="settings">
      <div class="line">
        <div class="item port-item">
          <div class="title">${text('PORT', 'Port')}</div>
          <div class="item-inner select-shell">
            <select id="port-select" aria-label="${escapeAttr(t('PORT', 'Port'))}" ${state.busy ? 'disabled' : ''}>
              <option value="">${text('UNSELECTED', 'Not selected')}</option>
              ${state.ports.map(port => `<option value="${escapeAttr(port.path)}" ${port.path === state.portPath ? 'selected' : ''}>${escapeHtml(port.path)}${port.name && port.name !== port.path ? ` - ${escapeHtml(port.name)}` : ''}</option>`).join('')}
            </select>
            <div class="value" title="${escapeAttr(`${portLabel}${portDetail}`)}">${escapeHtml(portLabel)}</div>
            <div class="arrow-box"><i class="fa-light fa-angle-right arrow"></i></div>
          </div>
        </div>
        <div class="switch">
          <button class="switch-control ${state.deviceInfo ? 'on' : ''}" data-action="${switchAction}" title="${escapeAttr(switchLabel)}" aria-label="${escapeAttr(switchLabel)}" ${state.deviceInfo ? (state.busy ? 'disabled' : '') : (!canUseDevice ? 'disabled' : '')}>
            <span class="switch-track"><span class="switch-thumb"></span></span>
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderDevicePanel() {
  const info = state.deviceInfo || {};
  const appBytes = state.partitions.filter(p => p.typeName === 'app').reduce((sum, item) => sum + Number(item.size || 0), 0);
  const fsBytes = filesystemPartitions().reduce((sum, item) => sum + Number(item.size || 0), 0);
  const fsTypes = Array.from(new Set(filesystemPartitions().map(item => getFsLabel(item.filesystemType)))).join(', ') || '-';

  return `
    <div class="summary-panel device-summary">
      <div class="panel-section">
        <div class="panel-title">${text('DEVICE.INFO', 'Device Info')}</div>
        <div class="info-list">
          <div class="info-row"><span>${text('DEVICE.CHIP', 'Chip')}</span><strong>${escapeHtml(info.chip || '-')}</strong></div>
          <div class="info-row"><span>MAC</span><strong>${escapeHtml(info.mac || '-')}</strong></div>
          <div class="info-row"><span>${text('DEVICE.FLASH_SIZE', 'Flash Size')}</span><strong>${escapeHtml(info.flashSize || '-')}</strong></div>
          <div class="info-row"><span>Flash ID</span><strong>${escapeHtml(info.flashId || '-')}</strong></div>
        </div>
      </div>
      <div class="panel-section">
        <div class="panel-title">${text('PARTITION.SCHEME', 'Partition Layout')}</div>
        <div class="info-list">
          <div class="info-row"><span>${text('PARTITION.COUNT', 'Partition Count')}</span><strong>${state.partitions.length || '-'}</strong></div>
          <div class="info-row"><span>${text('PARTITION.APP', 'App Partition')}</span><strong>${escapeHtml(appBytes ? formatBytes(appBytes) : '-')}</strong></div>
          <div class="info-row"><span>${text('PARTITION.FILE', 'Filesystem Partition')}</span><strong>${escapeHtml(fsBytes ? formatBytes(fsBytes) : '-')}</strong></div>
          <div class="info-row"><span>${text('PARTITION.FILESYSTEM', 'Filesystem')}</span><strong>${escapeHtml(fsTypes)}</strong></div>
        </div>
      </div>
    </div>
  `;
}

function renderPartitionPanel() {
  const total = state.partitions.reduce((sum, item) => sum + Number(item.size || 0), 0);

  return `
    <div class="summary-panel partition-area">
      <div class="partition-map-wrapper">
        ${state.partitions.length ? `
        <div class="partition-map">
          <div class="partition-track">
            ${state.partitions.map((partition, index) => `
              <div class="partition-segment ${escapeAttr(getPartitionCategory(partition))} ${index === state.selectedPartitionIndex ? 'selected' : ''}" data-action="select-partition" data-index="${index}" style="width:${Math.max(2, partition.size / total * 100)}%" title="${escapeAttr(partitionTooltip(partition))}">
                <div class="seg-inner">
                  <span class="seg-label">${escapeHtml(partition.label || partition.offsetHex)}</span>
                  <span class="seg-size">${escapeHtml(partition.sizeText || '')}</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : `<div class="empty-hint ccenter">${text('PARTITION.NO_DATA', 'No partition data')}</div>`}
      </div>
    </div>
  `;
}

function renderFilesystemManager(partition, session, entries, canUseDevice) {
  const canManage = Boolean(state.portPath && partition?.filesystemType && !state.busy);
  const canSave = Boolean(session && state.filesystemDirty && state.portPath && !state.busy);
  const supportsDirectory = ['littlefs', 'fatfs'].includes(session?.type || partition?.filesystemType || '');
  const fsLabel = getFsLabel(session?.type || partition?.filesystemType || null);

  return `
    <div class="summary-panel filesystem-panel">
      <div class="explorer">
        <div class="title-bar">
          <div class="title-left">
            <span class="title-text">${escapeHtml(fsLabel)} ${text('FILESYSTEM.EXPLORER', 'Explorer')}</span>
          </div>
          ${session?.usage ? `
          <div class="usage-mini" title="${escapeAttr(t('FILESYSTEM.USAGE_TOOLTIP', 'Used {{used}} / {{capacity}}, free {{free}}', {
            used: session.usage.usedText,
            capacity: session.usage.capacityText,
            free: session.usage.freeText
          }))}">
            <div class="usage-mini-track"><div class="usage-mini-bar" style="width:${session.usage.usedPercent}%"></div></div>
            <span>${session.usage.usedPercent}%</span>
          </div>
          ` : ''}
        </div>
        <div class="toolbar">
          <div class="nav-group">
            <div class="path" title="${escapeAttr(state.currentPath)}">
              <i class="fa-light fa-folder-tree"></i>
              <span class="path-text">${escapeHtml(state.currentPath)}</span>
            </div>
          </div>
          <div class="action-group">
            ${renderIconButton('load-fs', 'fa-light fa-arrows-rotate', t('FILESYSTEM.RELOAD_PARTITION', 'Reload partition'), !partition?.filesystemType || !canUseDevice)}
            ${renderIconButton('upload-file', 'fa-light fa-upload', t('FILESYSTEM.UPLOAD', 'Upload'), !session || state.busy)}
            ${supportsDirectory ? renderIconButton('mkdir', 'fa-light fa-folder-plus', t('FILESYSTEM.NEW_FOLDER', 'New folder'), !session || state.busy) : ''}
            ${renderIconButton('download-partition', 'fa-light fa-file-arrow-down', t('FILESYSTEM.EXPORT_PARTITION_IMAGE', 'Export partition image'), !partition?.filesystemType || !canUseDevice)}
            ${renderIconButton('restore-partition', 'fa-light fa-file-arrow-up', t('FILESYSTEM.IMPORT_IMAGE', 'Import image'), !canManage)}
            ${renderIconButton('format-fs', 'fa-light fa-broom-wide', t('FILESYSTEM.FORMAT', 'Format'), !session || state.busy, 'danger dd')}
            ${renderIconButton('erase-partition', 'fa-light fa-trash-can', t('FILESYSTEM.DELETE', 'Erase'), !partition?.filesystemType || !canUseDevice, 'danger dd')}
            <span class="tb-divider"></span>
            <button class="tb-btn primary" data-action="save-fs" title="${escapeAttr(t('FILESYSTEM.WRITE_BACK', 'Write back'))}" ${!canSave ? 'disabled' : ''}>
              <i class="fa-light fa-floppy-disk"></i>
              <span>${text('FILESYSTEM.WRITE_BACK', 'Write back')}</span>
            </button>
          </div>
        </div>
        <div class="list">
          ${renderFileTable(entries)}
        </div>
        <div class="status-bar">
          <div class="status-left">
            <span>${escapeHtml(state.filesystemStatusText || '')}</span>
          </div>
          <div class="status-right">
            ${session ? `<span>${text('FILESYSTEM.ITEM_COUNT', '{{count}} items', { count: entries.length })}</span>` : ''}
            ${state.selectedFilePath ? `<span class="sep-dot">/</span><span>${text('FILESYSTEM.SELECTED', 'Selected {{name}}', { name: entryNameFromPath(state.selectedFilePath) })}</span>` : ''}
            ${state.filesystemDirty ? `<span class="sep-dot">/</span><span class="dirty-text">${text('FILESYSTEM.WRITE_BACK', 'Write back')}</span>` : ''}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderFileTable(entries) {
  const session = state.filesystemSession;
  const head = `
    <div class="list-head">
      <div class="col-name">${text('FILESYSTEM.NAME', 'Name')}</div>
      <div class="col-type">${text('FILESYSTEM.TYPE', 'Type')}</div>
      <div class="col-size">${text('FILESYSTEM.SIZE', 'Size')}</div>
      <div class="col-actions"></div>
    </div>
  `;

  if (!session) {
    return `${head}<div class="list-body"><div class="empty"></div></div>`;
  }

  return `
    ${head}
    <div class="list-body sscroll ${state.busy ? 'is-loading' : ''}">
      ${state.busy ? `<div class="loading-overlay"><i class="fa-duotone fa-solid fa-spinner fa-spin spinner"></i></div>` : ''}
      ${state.currentPath !== '/' ? `
      <div class="row up-row" data-action="go-up">
        <div class="col-name"><i class="fa-light fa-turn-up"></i><span>..</span></div>
        <div class="col-type">${text('FILESYSTEM.PARENT', 'Parent')}</div>
        <div class="col-size"></div>
        <div class="col-actions"></div>
      </div>
      ` : ''}
      ${entries.map(entry => `
      <div class="row ${entry.type === 'dir' ? 'dir' : ''} ${entry.path === state.selectedFilePath ? 'selected' : ''}" data-action="${entry.type === 'dir' ? 'open-dir' : 'select-file'}" data-path="${escapeAttr(entry.path)}">
        <div class="col-name">
          <i class="${escapeAttr(getFileIconClass(entry))}"></i>
          <span title="${escapeAttr(entry.name)}">${escapeHtml(entry.name)}</span>
        </div>
        <div class="col-type">${escapeHtml(entry.type === 'dir' ? t('FILESYSTEM.FOLDER', 'Folder') : getFileTypeLabel(entry.name))}</div>
        <div class="col-size mono">${escapeHtml(entry.sizeText || '')}</div>
        <div class="col-actions">
          ${entry.type === 'file' && getPreviewMode(entry.name) ? renderIconButton('preview-file', getPreviewIconClass(entry.name), getPreviewLabel(entry.name), state.busy, 'icon-btn', entry.path) : ''}
          ${entry.type === 'file' ? renderIconButton('download-file', 'fa-light fa-download', t('FILESYSTEM.DOWNLOAD', 'Download'), state.busy, 'icon-btn', entry.path) : ''}
          ${renderIconButton('rename-entry', 'fa-light fa-pen', t('FILESYSTEM.RENAME', 'Rename'), state.busy, 'icon-btn', entry.path)}
          ${renderIconButton('delete-entry', 'fa-light fa-trash', t('FILESYSTEM.DELETE', 'Delete'), state.busy, 'icon-btn danger', entry.path)}
        </div>
      </div>
      `).join('')}
      ${entries.length ? '' : `<div class="empty inner"><i class="fa-light fa-folder-open"></i><p>${state.currentPath === '/' ? text('FILESYSTEM.EMPTY_FILESYSTEM', 'This filesystem is empty') : text('FILESYSTEM.EMPTY_DIRECTORY', 'This folder is empty')}</p></div>`}
    </div>
  `;
}

function renderIconButton(action, iconClass, label, disabled, extraClass = '', path = '') {
  return `
    <button class="tb-btn ${escapeAttr(extraClass)}" data-action="${escapeAttr(action)}" ${path ? `data-path="${escapeAttr(path)}"` : ''} title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" ${disabled ? 'disabled' : ''}>
      <i class="${escapeAttr(iconClass)}"></i>
    </button>
  `;
}

function partitionTooltip(partition) {
  return [
    partition.label || '-',
    `${partition.typeName || '-'} / ${partition.subtypeName || '-'}`,
    `Offset ${partition.offsetHex || '-'}`,
    partition.sizeText || ''
  ].filter(Boolean).join('\n');
}

function entryNameFromPath(path) {
  const segments = String(path || '').split('/').filter(Boolean);
  return segments[segments.length - 1] || path || '';
}

function getFileIconClass(entry) {
  if (entry.type === 'dir') return 'fa-light fa-folder';
  const ext = String(entry.name || '').split('.').pop()?.toLowerCase() || '';
  if (['txt', 'log', 'md', 'cfg', 'ini', 'conf'].includes(ext)) return 'fa-light fa-file-lines';
  if (['json', 'yaml', 'yml', 'xml', 'toml', 'js', 'ts', 'py', 'c', 'cpp', 'h', 'hpp', 'sh'].includes(ext)) return 'fa-light fa-file-code';
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) return 'fa-light fa-file-image';
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 'fa-light fa-file-audio';
  if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'fa-light fa-file-video';
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return 'fa-light fa-file-zipper';
  if (ext === 'bin') return 'fa-light fa-file-binary';
  return 'fa-light fa-file';
}

function getPreviewIconClass(name) {
  const mode = getPreviewMode(name);
  if (mode === 'image') return 'fa-light fa-image';
  if (mode === 'audio') return 'fa-light fa-headphones';
  return 'fa-light fa-eye';
}

function getPreviewLabel(name) {
  const mode = getPreviewMode(name);
  if (mode === 'audio') return t('FILESYSTEM.PREVIEW_AUDIO', 'Preview audio');
  return t('FILESYSTEM.PREVIEW_VIEW', 'Preview');
}

function renderModal() {
  const modal = state.modal;
  if (!modal) return '';
  let content = '';
  if (modal.type === 'text') content = `<pre>${escapeHtml(modal.content)}</pre>`;
  if (modal.type === 'image') content = `<img src="${escapeAttr(modal.url)}" alt="${escapeAttr(modal.title)}">`;
  if (modal.type === 'audio') content = `<audio controls autoplay src="${escapeAttr(modal.url)}"></audio>`;
  return `
    <div class="modal" data-action="close-modal">
      <div class="modal-box" data-modal-box>
        <div class="modal-header">${escapeHtml(modal.title)}</div>
        <div class="modal-content">${content}</div>
        <div class="modal-footer"><button data-action="close-modal">${text('VIEWER.CLOSE', 'Close')}</button></div>
      </div>
    </div>
  `;
}

function getDisplayEntries(files, currentPath) {
  const normalizedCurrent = normalizePath(currentPath || '/');
  const rows = [];
  for (const entry of files || []) {
    if (entry.path === normalizedCurrent) continue;
    const parent = parentPath(entry.path);
    if (parent === normalizedCurrent) rows.push(entry);
  }
  return rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

function parentPath(path) {
  const normalized = normalizePath(path);
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length <= 1) return '/';
  return `/${segments.slice(0, -1).join('/')}`;
}

function goUp() {
  state.currentPath = parentPath(state.currentPath);
  state.selectedFilePath = '';
  render();
}

function getPartitionCategory(partition) {
  if (partition.filesystemType) return partition.filesystemType;
  if (partition.typeName === 'app') return 'app';
  const subtype = String(partition.subtypeName || partition.subtype || '').toLowerCase();
  if (subtype.includes('boot')) return 'bootloader';
  if (subtype.includes('nvs')) return 'nvs';
  if (subtype.includes('ota')) return 'otadata';
  if (subtype.includes('phy')) return 'phy';
  if (subtype.includes('core')) return 'coredump';
  return 'normal';
}

function getFsLabel(type) {
  if (type === 'spiffs') return 'SPIFFS';
  if (type === 'littlefs') return 'LittleFS';
  if (type === 'fatfs') return 'FATFS';
  return t('COMMON.NORMAL_PARTITION', 'Normal partition');
}

function getPartitionDisplayName(partition) {
  return partition?.label || partition?.offsetHex || '';
}

function getFileTypeLabel(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  return ext ? t('FILESYSTEM.FILE_WITH_EXT', '{{ext}} file', { ext: ext.toUpperCase() }) : t('FILESYSTEM.FILE', 'File');
}

function getPreviewMode(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
  if (['txt', 'log', 'md', 'cfg', 'ini', 'conf', 'json', 'yaml', 'yml', 'xml', 'toml', 'js', 'ts', 'py', 'c', 'cpp', 'h', 'hpp', 'sh', 'csv', 'html', 'htm', 'css'].includes(ext)) return 'text';
  return null;
}

function buildPartitionFileName(partition) {
  const label = sanitizeFileName(partition.label || `partition_${partition.index}`);
  const suffix = partition.filesystemType || String(partition.subtypeName || 'partition').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return `${label}_${partition.offsetHex}_${suffix}.bin`;
}

function sanitizeFileName(value) {
  return String(value || 'partition').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || 'partition';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = value >= 10 || index === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index]}`;
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function toBlobPart(data) {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function downloadBytes(fileName, data, type) {
  const url = URL.createObjectURL(new Blob([toBlobPart(data)], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function chooseFile(accept, callback) {
  const input = document.createElement('input');
  input.type = 'file';
  if (accept) input.accept = accept;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void callback(file);
  });
  input.click();
}

function createFilesystemContent() {
  return {
    async mountPartition(partition, image) {
      if (!partition.filesystemType) {
        throw new Error('Please select a SPIFFS / LittleFS / FATFS partition');
      }
      const type = partition.filesystemType;
      const mounted = {
        type,
        partition,
        client: await this.createClient(type, image),
        image,
        files: [],
        usage: null
      };
      mounted.files = await this.listFiles(mounted);
      mounted.usage = await this.getUsage(mounted);
      return mounted;
    },
    async listFiles(filesystem) {
      let entries = [];
      if (filesystem.type === 'spiffs') entries = await filesystem.client.list();
      else if (filesystem.type === 'littlefs') entries = this.listLittlefsEntries(filesystem.client);
      else entries = this.listFatfsEntries(filesystem.client);
      return entries.map(entry => this.normalizeEntry(filesystem.type, entry)).sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
    },
    async readFile(filesystem, path) {
      const normalized = this.normalizeFilePath(path, filesystem.type);
      if (filesystem.type === 'spiffs') return await filesystem.client.read(normalized);
      return filesystem.client.readFile(this.toClientPath(filesystem.type, normalized));
    },
    async writeFile(filesystem, path, data) {
      const normalized = this.normalizeFilePath(path, filesystem.type);
      if (filesystem.type === 'spiffs') {
        await filesystem.client.write(normalized, data);
        return;
      }
      this.ensureParentDirectories(filesystem, normalized);
      filesystem.client.writeFile(this.toClientPath(filesystem.type, normalized), data);
    },
    async deleteEntry(filesystem, entry) {
      if (filesystem.type === 'spiffs') {
        await filesystem.client.remove(entry.path);
        return;
      }
      const path = this.toClientPath(filesystem.type, entry.path);
      if (filesystem.type === 'littlefs' && entry.type === 'dir') {
        filesystem.client.delete(path, { recursive: true });
        return;
      }
      filesystem.client.deleteFile(path);
    },
    async renameEntry(filesystem, entry, newPath) {
      const normalized = entry.type === 'dir' ? this.normalizeDirectoryPath(newPath) : this.normalizeFilePath(newPath, filesystem.type);
      if (filesystem.type === 'spiffs') {
        const data = await this.readFile(filesystem, entry.path);
        await filesystem.client.write(normalized, data);
        await filesystem.client.remove(entry.path);
        return;
      }
      this.ensureParentDirectories(filesystem, normalized);
      filesystem.client.rename(this.toClientPath(filesystem.type, entry.path), this.toClientPath(filesystem.type, normalized));
    },
    async mkdir(filesystem, path) {
      if (filesystem.type === 'spiffs') throw new Error('SPIFFS does not support directories');
      const normalized = this.normalizeDirectoryPath(path);
      this.ensureParentDirectories(filesystem, normalized);
      filesystem.client.mkdir(this.toClientPath(filesystem.type, normalized));
    },
    async format(filesystem) {
      await filesystem.client.format();
    },
    async toImage(filesystem) {
      return await filesystem.client.toImage();
    },
    async getUsage(filesystem) {
      if (!filesystem.client.getUsage) return null;
      const usage = await filesystem.client.getUsage();
      if (!usage) return null;
      const capacityBytes = Number(usage.capacityBytes || 0);
      const usedBytes = filesystem.type === 'fatfs'
        ? this.listFatfsEntries(filesystem.client).reduce((total, entry) => entry.type === 'file' ? total + Number(entry.size || 0) : total, 0)
        : Number(usage.usedBytes || 0);
      const freeBytes = capacityBytes > usedBytes ? capacityBytes - usedBytes : Number(usage.freeBytes || 0);
      return {
        capacityBytes,
        usedBytes,
        freeBytes,
        capacityText: formatBytes(capacityBytes),
        usedText: formatBytes(usedBytes),
        freeText: formatBytes(freeBytes),
        usedPercent: capacityBytes ? Math.min(100, Math.round(usedBytes / capacityBytes * 100)) : 0
      };
    },
    async createClient(type, image) {
      if (type === 'spiffs') return await this.createSpiffsClient(image);
      if (type === 'littlefs') return await this.createLittlefsClient(image);
      return await this.createFatfsClient(image);
    },
    async createSpiffsClient(image) {
      const { createSpiffsFromImage, createSpiffs } = await import('./wasm/spiffs/index.js');
      const wasmURL = this.getWasmUrl('spiffs/spiffs.wasm');
      if (this.isBlankImage(image)) {
        const blockSize = DEFAULT_BLOCK_SIZE;
        const blockCount = Math.max(1, Math.floor(image.length / blockSize));
        return await createSpiffs({ wasmURL, pageSize: SPIFFS_PAGE_SIZE, blockSize, blockCount, formatOnInit: true });
      }
      let lastError;
      try {
        return await createSpiffsFromImage(image, { wasmURL });
      } catch (error) {
        lastError = error;
      }
      for (const blockSize of BLOCK_SIZE_CANDIDATES) {
        if (blockSize === DEFAULT_BLOCK_SIZE || image.length % blockSize !== 0) continue;
        try {
          return await createSpiffsFromImage(image, { wasmURL, pageSize: SPIFFS_PAGE_SIZE, blockSize, blockCount: image.length / blockSize });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('Failed to initialize SPIFFS from image');
    },
    async createLittlefsClient(image) {
      const { createLittleFSFromImage, createLittleFS } = await import('./wasm/littlefs/index.js');
      const wasmURL = this.getWasmUrl('littlefs/littlefs.wasm');
      if (this.isBlankImage(image)) {
        const blockSize = DEFAULT_BLOCK_SIZE;
        const blockCount = Math.max(1, Math.floor(image.length / blockSize));
        return await createLittleFS({ wasmURL, blockSize, blockCount, formatOnInit: true });
      }
      let lastError;
      for (const blockSize of BLOCK_SIZE_CANDIDATES) {
        if (image.length % blockSize !== 0) continue;
        try {
          return await createLittleFSFromImage(image, { wasmURL, blockSize, blockCount: image.length / blockSize });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('Unable to mount LittleFS image');
    },
    async createFatfsClient(image) {
      const { createFatFSFromImage } = await import('./wasm/fatfs/index.js');
      return await createFatFSFromImage(image, { wasmURL: this.getWasmUrl('fatfs/fatfs.wasm'), blockSize: DEFAULT_BLOCK_SIZE });
    },
    listLittlefsEntries(client) {
      const entries = [];
      const stack = ['/'];
      while (stack.length) {
        const currentPath = stack.pop() || '/';
        for (const entry of client.list(currentPath)) {
          entries.push(entry);
          if (entry.type === 'dir') stack.push(entry.path);
        }
      }
      return entries;
    },
    listFatfsEntries(client) {
      const entries = [];
      const stack = [FAT_MOUNT];
      while (stack.length) {
        const currentPath = stack.pop() || FAT_MOUNT;
        for (const entry of client.list(currentPath)) {
          entries.push(entry);
          if (entry.type === 'dir') stack.push(entry.path);
        }
      }
      return entries;
    },
    normalizeEntry(type, entry) {
      let path = String(entry.path || entry.name || '');
      if (type === 'fatfs') path = this.stripFatMount(path);
      path = normalizePath(path);
      const segments = path.split('/').filter(Boolean);
      const name = String(entry.name || segments[segments.length - 1] || path);
      const entryType = entry.type === 'dir' ? 'dir' : 'file';
      const size = entryType === 'file' ? Number(entry.size || 0) : 0;
      return { name, path, type: entryType, size, sizeText: entryType === 'file' ? formatBytes(size) : '-' };
    },
    normalizeFilePath(path, type) {
      const normalized = normalizePath(path);
      const segments = normalized.split('/').filter(Boolean);
      if (!segments.length) throw new Error('File path cannot be empty');
      if (type === 'spiffs' && segments.length > 1) throw new Error('SPIFFS file names cannot contain directories');
      return `/${segments.join('/')}`;
    },
    normalizeDirectoryPath(path) {
      const normalized = normalizePath(path);
      if (normalized === '/') throw new Error('Directory path cannot be empty');
      return normalized;
    },
    ensureParentDirectories(filesystem, filePath) {
      if (filesystem.type === 'spiffs') return;
      const segments = filePath.split('/').filter(Boolean);
      if (segments.length <= 1) return;
      let currentPath = '';
      for (const segment of segments.slice(0, -1)) {
        currentPath += `/${segment}`;
        try {
          filesystem.client.mkdir(this.toClientPath(filesystem.type, currentPath));
        } catch {
          // Directory already exists or cannot be created; the final write will surface real errors.
        }
      }
    },
    toClientPath(type, path) {
      if (type === 'fatfs') return this.hasFatMount(path) ? path : `${FAT_MOUNT}${path}`;
      return path;
    },
    stripFatMount(path) {
      const normalized = String(path || '');
      if (normalized.toLowerCase() === FAT_MOUNT) return '/';
      if (this.hasFatMount(normalized)) return normalized.slice(FAT_MOUNT.length) || '/';
      return normalized;
    },
    hasFatMount(path) {
      const lowerPath = String(path || '').toLowerCase();
      return lowerPath === FAT_MOUNT || lowerPath.startsWith(`${FAT_MOUNT}/`);
    },
    getDefaultUploadFileName(fileName) {
      return this.sanitizePathSegment(fileName || 'file.bin');
    },
    sanitizePathSegment(value) {
      return String(value || 'file.bin').replace(/[\\/:*?"<>|]+/g, '_').replace(/^_+|_+$/g, '') || 'file.bin';
    },
    validateUploadFileName(fileName, type) {
      const safeName = this.getDefaultUploadFileName(fileName);
      const byteLength = textEncoder.encode(safeName).length;
      const maxBytes = FILE_NAME_MAX_BYTES[type];
      if (byteLength <= maxBytes) return null;
      return `${FILESYSTEM_LABELS[type]} filename is too long: ${byteLength} bytes, max ${maxBytes} bytes.`;
    },
    isBlankImage(image) {
      if (!image.length) return false;
      const samples = [0, image.length - 1, image.length >> 1];
      for (const index of samples) {
        if (image[index] !== 0xff) return false;
      }
      for (let index = 0; index < image.length; index += 1) {
        if (image[index] !== 0xff) return false;
      }
      return true;
    },
    getWasmUrl(path) {
      return new URL(`./wasm/${path}`, document.baseURI).href;
    }
  };
}

function normalizePath(path) {
  const normalized = String(path || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  const withoutFatMount = normalized.toLowerCase() === FAT_MOUNT || normalized.toLowerCase().startsWith(`${FAT_MOUNT}/`)
    ? normalized.slice(FAT_MOUNT.length) || '/'
    : normalized;
  const prefixed = withoutFatMount.startsWith('/') ? withoutFatMount : `/${withoutFatMount}`;
  const segments = prefixed.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) throw new Error('Path cannot contain . or ..');
  return segments.length ? `/${segments.join('/')}` : '/';
}

app.addEventListener('change', event => {
  if (event.target?.id === 'port-select') {
    state.portPath = event.target.value;
    render();
  }
  if (event.target?.id === 'baud-select') {
    state.baudRate = Number(event.target.value) || 921600;
    render();
  }
});

app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'close-modal' && event.target.closest('[data-modal-box]') && !event.target.closest('button')) {
    return;
  }
  if (target.closest('[data-modal-box]') && action !== 'close-modal') {
    event.stopPropagation();
  }
  const path = target.dataset.path;
  switch (action) {
    case 'ports':
      void loadPorts();
      break;
    case 'refresh':
      void refreshAll();
      break;
    case 'disconnect':
      void releaseSession(false);
      break;
    case 'select-partition':
      void selectPartitionByIndex(Number(target.dataset.index));
      break;
    case 'load-fs':
      void loadFilesystemContent();
      break;
    case 'save-fs':
      void saveFilesystemContent();
      break;
    case 'download-partition':
      void downloadSelectedPartition();
      break;
    case 'restore-partition':
      chooseFile('.bin,application/octet-stream', restoreSelectedPartition);
      break;
    case 'erase-partition':
      void eraseSelectedPartition();
      break;
    case 'upload-file':
      chooseFile('', uploadFileToFilesystem);
      break;
    case 'mkdir':
      void createFilesystemDirectory();
      break;
    case 'format-fs':
      void formatFilesystemContent();
      break;
    case 'go-up':
      goUp();
      break;
    case 'open-dir':
      state.currentPath = normalizePath(path);
      state.selectedFilePath = '';
      render();
      break;
    case 'select-file':
      state.selectedFilePath = path || '';
      render();
      break;
    case 'preview-file':
      event.stopPropagation();
      void previewFilesystemFile(path);
      break;
    case 'download-file':
      event.stopPropagation();
      void downloadFilesystemFile(path);
      break;
    case 'rename-entry':
      event.stopPropagation();
      void renameFilesystemEntry(path);
      break;
    case 'delete-entry':
      event.stopPropagation();
      void deleteFilesystemEntry(path);
      break;
    case 'close-modal':
      closeModal();
      break;
  }
});

void loadI18n(host.context.lang);
connectHost();
connectBackend();
