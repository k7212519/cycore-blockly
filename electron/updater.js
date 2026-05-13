const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain, dialog, screen, shell } = require("electron");
// 添加autoUpdater引入
const { autoUpdater, CancellationToken } = require('electron-updater');
const { GenericProvider } = require('electron-updater/out/providers/GenericProvider');

let cancellationToken = null;
let checkedUpdateInfoAndProvider = null;
let downloadMirrorFallbackInProgress = false;

function logUpdater(message, data) {
  const text = data === undefined
    ? `[Updater] ${message}`
    : `[Updater] ${message} ${JSON.stringify(data)}`;
  if (autoUpdater.logger && typeof autoUpdater.logger.info === 'function') {
    autoUpdater.logger.info(text);
    return;
  }

  console.log(text);
}

function loadMergedConfig() {
  const configPath = path.join(__dirname, 'config', 'config.json');
  let config = {};

  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.warn('读取默认配置失败:', error.message || error);
  }

  const userConfigPath = process.env.AILY_APPDATA_PATH
    ? path.join(process.env.AILY_APPDATA_PATH, 'config.json')
    : '';

  if (userConfigPath && fs.existsSync(userConfigPath)) {
    try {
      const userConfig = JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
      config = {
        ...config,
        ...userConfig,
        regions: {
          ...(config.regions || {}),
          ...(userConfig.regions || {}),
        },
        update_download_strategy: {
          ...(config.update_download_strategy || {}),
          ...(userConfig.update_download_strategy || {}),
        },
      };
    } catch (error) {
      console.warn('读取用户配置失败:', error.message || error);
    }
  }

  return config;
}

function getDownloadMirrorSources() {
  const config = loadMergedConfig();
  const strategy = config.update_download_strategy || {};

  if (strategy.enabled === false) {
    return [];
  }

  const regions = config.regions || {};
  const regionOrder = Array.isArray(strategy.mirror_region_order) && strategy.mirror_region_order.length > 0
    ? strategy.mirror_region_order
    : ['eu', 'cn'];

  const seenUrls = new Set();
  return regionOrder
    .map((regionKey) => {
      const updaterUrl = regions[regionKey] && regions[regionKey].updater;
      if (typeof updaterUrl !== 'string' || updaterUrl.trim() === '') {
        return null;
      }

      const url = updaterUrl.trim().replace(/\/+$/, '');
      if (seenUrls.has(url)) {
        return null;
      }

      seenUrls.add(url);
      return { region: regionKey, url };
    })
    .filter(Boolean);
}

function shouldFallbackOnDownloadError() {
  const config = loadMergedConfig();
  const strategy = config.update_download_strategy || {};
  return strategy.fallback_on_error !== false;
}

function createMirrorProvider(url) {
  const runtimeOptions = typeof autoUpdater.createProviderRuntimeOptions === 'function'
    ? autoUpdater.createProviderRuntimeOptions()
    : {
        executor: autoUpdater.httpExecutor,
        platform: process.platform,
        isUseMultipleRangeRequest: false,
      };

  return new GenericProvider(
    { provider: 'generic', url },
    autoUpdater,
    {
      ...runtimeOptions,
      isUseMultipleRangeRequest: false,
    }
  );
}

function getPlatformChannelPrefix() {
  if (process.platform === 'darwin') {
    return '-mac';
  }

  if (process.platform === 'linux') {
    const arch = process.env.TEST_UPDATER_ARCH || process.arch;
    return arch === 'x64' ? '-linux' : `-linux-${arch}`;
  }

  return '';
}

function getChannelFileName() {
  const channel = autoUpdater.channel || 'latest';
  return `${channel}${getPlatformChannelPrefix()}.yml`;
}

function joinUrl(baseUrl, fileName) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/${fileName.replace(/^\/+/, '')}`;
}

function normalizePublishConfig(config) {
  if (Array.isArray(config)) {
    return config[0] || null;
  }
  return config || null;
}

async function logDefaultUpdateCheckUrl() {
  try {
    const config = normalizePublishConfig(await autoUpdater.configOnDisk.value);
    if (config && config.url) {
      logUpdater('checking update manifest', {
        provider: config.provider || 'generic',
        url: joinUrl(config.url, getChannelFileName()),
      });
    } else {
      logUpdater('checking update manifest with packaged updater config');
    }
  } catch (error) {
    logUpdater('checking update manifest, but failed to read updater config', {
      error: serializeError(error),
    });
  }
}

function getResolvedDownloadUrls(updateInfoAndProvider) {
  if (!updateInfoAndProvider || !updateInfoAndProvider.info || !updateInfoAndProvider.provider) {
    return [];
  }

  try {
    return updateInfoAndProvider.provider
      .resolveFiles(updateInfoAndProvider.info)
      .map((file) => file.url.href);
  } catch (error) {
    logUpdater('failed to resolve download urls', {
      error: serializeError(error),
    });
    return [];
  }
}

function isCancellationError(error) {
  return Boolean(
    error &&
    (
      error.message === 'cancelled' ||
      error.name === 'CancellationError' ||
      String(error.message || error).toLowerCase().includes('cancelled')
    )
  );
}

function serializeError(error) {
  if (!error) {
    return 'Unknown updater error';
  }
  return error.stack || error.message || error.toString();
}

async function downloadWithCurrentProvider() {
  cancellationToken = new CancellationToken();
  logUpdater('downloading installer', {
    urls: getResolvedDownloadUrls(autoUpdater.updateInfoAndProvider),
  });
  try {
    return await autoUpdater.downloadUpdate(cancellationToken);
  } finally {
    cancellationToken = null;
  }
}

async function downloadWithMirrors(mainWindow) {
  const baseUpdateInfoAndProvider = checkedUpdateInfoAndProvider || autoUpdater.updateInfoAndProvider;
  if (!baseUpdateInfoAndProvider || !baseUpdateInfoAndProvider.info) {
    throw new Error('Please check update first');
  }

  const mirrors = getDownloadMirrorSources();
  if (mirrors.length === 0) {
    return await downloadWithCurrentProvider();
  }

  const fallbackEnabled = shouldFallbackOnDownloadError();
  const originalUpdateInfoAndProvider = autoUpdater.updateInfoAndProvider;
  const checkedInfo = baseUpdateInfoAndProvider.info;
  let lastError = null;

  downloadMirrorFallbackInProgress = true;
  try {
    for (let index = 0; index < mirrors.length; index++) {
      const mirror = mirrors[index];
      const mirrorProvider = createMirrorProvider(mirror.url);
      autoUpdater.updateInfoAndProvider = {
        info: checkedInfo,
        provider: mirrorProvider,
      };

      logUpdater('switching update download mirror', {
        region: mirror.region,
        baseUrl: mirror.url,
        urls: getResolvedDownloadUrls(autoUpdater.updateInfoAndProvider),
      });

      mainWindow?.webContents.send('update-status', {
        status: 'mirror-switching',
        source: mirror,
        index,
        total: mirrors.length,
      });

      try {
        return await downloadWithCurrentProvider();
      } catch (error) {
        lastError = error;
        if (isCancellationError(error)) {
          throw error;
        }

        console.error(`Download from updater mirror failed (${mirror.region}, ${mirror.url}):`, error);

        const hasNextMirror = index < mirrors.length - 1;
        if (!fallbackEnabled || !hasNextMirror) {
          throw error;
        }
      }
    }
  } finally {
    downloadMirrorFallbackInProgress = false;
    if (lastError) {
      autoUpdater.updateInfoAndProvider = originalUpdateInfoAndProvider || baseUpdateInfoAndProvider;
    }
  }

  throw lastError || new Error('No updater mirror was available');
}

// 添加自动更新处理函数
function registerUpdaterHandlers(mainWindow) {

  // 强制使用开发环境配置
  // if (process.env.DEV === 'true' || process.env.DEV === true) {
  //   autoUpdater.forceDevUpdateConfig = true;
  //   autoUpdater.allowDowngrade = true;
  //   autoUpdater.logger = require("electron-log");
  //   autoUpdater.logger.transports.file.level = "debug";
  // }

  autoUpdater.autoDownload = false;  // 禁用自动下载
  // autoUpdater.allowDowngrade = true; // 允许版本降级
  autoUpdater.useMultipleRangeRequest = false; // 禁用多范围请求
  autoUpdater.disableDifferentialDownload = true; // 禁用差量下载，使用完整下载

  // 添加IPC处理程序，允许从渲染进程手动检查更新
  ipcMain.handle('check-for-updates', async () => {
    await logDefaultUpdateCheckUrl();
    const result = await autoUpdater.checkForUpdates();
    // console.log('检查更新结果:', result);
    return JSON.parse(JSON.stringify(result))
  });

  // 添加IPC处理程序，允许从渲染进程安装更新
  ipcMain.on('quit-and-install', () => {
    autoUpdater.quitAndInstall();
  });

  // 添加IPC处理程序，手动下载更新
  ipcMain.handle('start-download', async () => {
    if (!cancellationToken) { // 防止重复下载
      try {
        const result = await downloadWithMirrors(mainWindow);
        console.log('Download finished:', result);
        return result;
      } catch (error) {
        if (isCancellationError(error)) {
          console.log('Download cancelled by user.');
          mainWindow?.webContents.send('download-cancelled'); // 发送取消事件
        } else {
          console.error('Download error:', error);
          mainWindow?.webContents.send('update-status', { // 使用 update-status 通道报告错误
            status: 'error',
            error: serializeError(error)
          });
        }
      } finally {
        cancellationToken = null; // 出错或取消后重置
      }
    }
  });

  // 添加IPC处理程序，取消下载更新
  ipcMain.handle('cancel-download', () => {
    if (cancellationToken) {
      cancellationToken.cancel();
    }
  });

  // 日志设置
  autoUpdater.logger = require("electron-log");
  autoUpdater.logger.transports.file.level = "info";

  // 设置检查更新时发送状态到渲染进程
  autoUpdater.on('checking-for-update', () => {
    mainWindow.webContents.send('update-status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    checkedUpdateInfoAndProvider = autoUpdater.updateInfoAndProvider || checkedUpdateInfoAndProvider;
    logUpdater('update available', {
      version: info && info.version,
      urls: getResolvedDownloadUrls(checkedUpdateInfoAndProvider),
    });
    mainWindow.webContents.send('update-status', {
      status: 'available',
      info: info
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    checkedUpdateInfoAndProvider = null;
    logUpdater('update not available', {
      version: info && info.version,
    });
    mainWindow.webContents.send('update-status', {
      status: 'not-available',
      info: info
    });
  });

  autoUpdater.on('error', (err) => {
    // 这个监听器主要处理检查更新阶段或非下载过程中的错误
    // 下载过程中的错误（包括取消）在 downloadUpdate 的 catch 中处理
    console.error('Updater error:', err);
    // 如果下载正在进行中被取消，这里的错误可能也会触发，但我们已经在 catch 中处理了
    // 避免重复发送错误状态，除非 token 已经是 null (表示非下载错误)
    if (!cancellationToken && !downloadMirrorFallbackInProgress) {
        mainWindow.webContents.send('update-status', {
          status: 'error',
          error: serializeError(err)
        });
    }
    // 确保 token 在任何错误后都被重置
    if (!downloadMirrorFallbackInProgress) {
      cancellationToken = null;
    }
  });

  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow.webContents.send('update-status', {
      status: 'progress',
      progress: progressObj
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    cancellationToken = null; // 确保下载成功后也重置 token
    mainWindow.webContents.send('update-status', {
      status: 'downloaded',
      info: info
    });
  });

  // 启动时检查更新
  // autoUpdater.checkForUpdates();
}


module.exports = {
  registerUpdaterHandlers,
};