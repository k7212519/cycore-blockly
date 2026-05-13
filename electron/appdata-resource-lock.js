const fs = require('fs');
const os = require('os');
const path = require('path');
const { ipcMain, app } = require('electron');

const LOCK_DIR = '.aily';
const LOCK_FILE = 'appdata-resource.lock';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_INTERVAL_MS = 500;

const heldLocks = new Map();
let handlersRegistered = false;

function getAppDataPath() {
  return process.env.AILY_APPDATA_PATH || app.getPath('userData');
}

function getLockPath() {
  return path.join(getAppDataPath(), LOCK_DIR, LOCK_FILE);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLockStaleAfterReboot(lockData) {
  if (!lockData || !lockData.startedAt) {
    return false;
  }
  const bootTimeMs = Date.now() - os.uptime() * 1000;
  return lockData.startedAt < bootTimeMs - 5000;
}

function readLock(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeLock(lockPath, payload) {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { flag: 'wx' });
}

function removeStaleLock(lockPath, holder, reason) {
  try {
    fs.unlinkSync(lockPath);
    console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_STALE_REMOVED]', {
      reason,
      holder
    });
    return true;
  } catch (error) {
    console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_STALE_REMOVE_FAILED]', {
      reason,
      error: error?.message || String(error),
      holder
    });
    return false;
  }
}

function isCurrentProcessLock(holder) {
  return holder?.pid === process.pid && heldLocks.has(holder?.token);
}

async function acquireAppDataResourceLock(label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const lockPath = getLockPath();
  const startedAt = Date.now();
  const token = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let lastHolderLogAt = 0;

  while (Date.now() - startedAt <= timeoutMs) {
    const payload = {
      token,
      pid: process.pid,
      execPath: process.execPath,
      appVersion: app.getVersion(),
      label,
      startedAt: Date.now()
    };

    try {
      writeLock(lockPath, payload);
      heldLocks.set(token, lockPath);
      console.info('[PROC_TRACE][APPDATA_FILE_LOCK_ACQUIRED]', {
        label,
        token,
        lockPath,
        waitMs: Date.now() - startedAt
      });
      return { ok: true, token, lockPath, waitMs: Date.now() - startedAt };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_ACQUIRE_ERROR]', {
          label,
          error: error?.message || String(error)
        });
        throw error;
      }
    }

    const holder = readLock(lockPath);
    if (!holder || isLockStaleAfterReboot(holder)) {
      removeStaleLock(lockPath, holder, !holder ? 'unreadable' : 'after-reboot');
      continue;
    }

    if (isCurrentProcessLock(holder)) {
      // 防止同一进程里偶发重入死等；正常情况下 renderer 本地队列会避免走到这里。
      console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_REENTER]', { label, holder });
      await sleep(RETRY_INTERVAL_MS);
      continue;
    }

    if (!isPidAlive(Number(holder.pid))) {
      removeStaleLock(lockPath, holder, 'dead-pid');
      continue;
    }

    const now = Date.now();
    if (now - lastHolderLogAt > 5000) {
      lastHolderLogAt = now;
      console.info('[PROC_TRACE][APPDATA_FILE_LOCK_WAIT]', {
        label,
        waitMs: now - startedAt,
        holder: {
          pid: holder.pid,
          label: holder.label,
          appVersion: holder.appVersion,
          startedAt: holder.startedAt
        }
      });
    }

    await sleep(RETRY_INTERVAL_MS);
  }

  const holder = readLock(lockPath);
  console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_TIMEOUT]', {
    label,
    timeoutMs,
    holder
  });
  return { ok: false, error: 'APPDATA_RESOURCE_LOCK_TIMEOUT', holder };
}

function releaseAppDataResourceLock(token) {
  const lockPath = heldLocks.get(token);
  if (!lockPath) {
    return { ok: true, alreadyReleased: true };
  }

  const holder = readLock(lockPath);
  if (holder?.pid === process.pid && holder?.token === token) {
    try {
      fs.unlinkSync(lockPath);
      console.info('[PROC_TRACE][APPDATA_FILE_LOCK_RELEASED]', {
        token,
        label: holder.label,
        lockPath
      });
    } catch (error) {
      console.warn('[PROC_TRACE][APPDATA_FILE_LOCK_RELEASE_ERROR]', {
        token,
        error: error?.message || String(error)
      });
      return { ok: false, error: error?.message || String(error) };
    }
  }

  heldLocks.delete(token);
  return { ok: true };
}

function releaseAllAppDataResourceLocks() {
  for (const token of Array.from(heldLocks.keys())) {
    releaseAppDataResourceLock(token);
  }
}

function registerAppDataResourceLockHandlers() {
  if (handlersRegistered) {
    return;
  }

  handlersRegistered = true;

  ipcMain.handle('appdata-resource-lock-acquire', async (_event, data = {}) => {
    return acquireAppDataResourceLock(data.label || 'unknown', data.timeoutMs || DEFAULT_TIMEOUT_MS);
  });

  ipcMain.handle('appdata-resource-lock-release', (_event, data = {}) => {
    return releaseAppDataResourceLock(data.token);
  });
}

module.exports = {
  registerAppDataResourceLockHandlers,
  releaseAllAppDataResourceLocks,
};
