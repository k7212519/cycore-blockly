// 窗口控制
const { ipcMain, BrowserWindow, app } = require("electron");
const { exec, execSync } = require('child_process');
const path = require('path');

const CODE_VIEWER_STATE_CHANNEL = 'blockly-code-viewer-state';
const CODE_VIEWER_STATE_UPDATE_CHANNEL = 'blockly-code-viewer-state-update';
const CODE_VIEWER_STATE_GET_CHANNEL = 'blockly-code-viewer-state-get';

/** 后台预缓冲子窗口数量：1 个待用 + 1 个备用 */
const SUB_WINDOW_POOL_SIZE = 2;

function isDevServeSubWindow() {
    return process.env.DEV === 'true' || process.env.DEV === true;
}

/**
 * 与正式子窗口一致的 webPreferences，用于预热池与即用窗口。
 */
function getSubWindowWebPreferences() {
    return {
        nodeIntegration: true,
        webSecurity: false,
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false,
    };
}

/** @type {import('electron').BrowserWindow[]} */
let subWindowPool = [];
/** @type {boolean} */
let subWindowReplenishScheduled = false;

function scheduleReplenishSubWindowPool(loadBasePage) {
    if (subWindowReplenishScheduled) {
        return;
    }
    subWindowReplenishScheduled = true;
    setImmediate(() => {
        subWindowReplenishScheduled = false;
        replenishSubWindowPool(loadBasePage);
    });
}

/**
 * 创建透明不可见（opacity 0）、不出现在任务栏的预缓冲子窗口并完成首屏加载。
 */
function pushPooledSubWindow(loadBasePage) {
    try {
        const win = new BrowserWindow({
            frame: false,
            show: false,
            transparent: true,
            opacity: 0,
            skipTaskbar: true,
            autoHideMenuBar: true,
            thickFrame: true,
            titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
            backgroundColor: '#00000000',
            alwaysOnTop: false,
            width: 800,
            height: 600,
            webPreferences: getSubWindowWebPreferences(),
        });

        const onClosedWhilePooled = () => {
            const idx = subWindowPool.indexOf(win);
            if (idx !== -1) {
                subWindowPool.splice(idx, 1);
            }
            delete win.__subWindowPoolClosedHandler;
            scheduleReplenishSubWindowPool(loadBasePage);
        };
        win.__subWindowPoolClosedHandler = onClosedWhilePooled;
        win.once('closed', onClosedWhilePooled);
        subWindowPool.push(win);
        loadBasePage(win.webContents);
    } catch (e) {
        console.warn('[SubWindowPool] 预缓冲子窗口创建失败:', e.message);
    }
}

function replenishSubWindowPool(loadBasePage) {
    while (subWindowPool.length < SUB_WINDOW_POOL_SIZE) {
        const prevLen = subWindowPool.length;
        pushPooledSubWindow(loadBasePage);
        if (subWindowPool.length === prevLen) {
            break;
        }
    }
}

/**
 * 从池中取出窗口后移除池的 closed 监听并触发补位。
 * @param {import('electron').BrowserWindow} win
 * @param {(wc: import('electron').WebContents) => void} loadBasePage
 */
function removePoolHandlersFromWin(win, loadBasePage) {
    const h = win.__subWindowPoolClosedHandler;
    if (typeof h === 'function') {
        win.removeListener('closed', h);
        delete win.__subWindowPoolClosedHandler;
    }
    scheduleReplenishSubWindowPool(loadBasePage);
}

function terminateAilyProcess() {
    const platform = process.platform;
    let checkCommand;
    let killCommand;
    const processName = platform === 'win32' ? 'aily blockly.exe' : 'aily blockly';

    if (platform === 'win32') {
        checkCommand = `tasklist /FI "IMAGENAME eq ${processName}" /FO CSV`;
        killCommand = `taskkill /F /IM "${processName}"`;
    } else {
        checkCommand = `pgrep -f "${processName}"`;
        killCommand = `pkill -f "${processName}"`;
    }

    try {
        let count = 0;
        try {
            const stdout = execSync(checkCommand, { encoding: 'utf8' });
            if (platform === 'win32') {
                const matches = stdout.match(new RegExp(processName.replace('.', '\\.'), 'gi'));
                count = matches ? matches.length : 0;
            } else {
                count = stdout.trim().split('\n').length;
            }
        } catch (e) {
            if (platform !== 'win32' && e.status === 1) {
                count = 0;
            } else {
                console.warn('Error checking process count:', e.message);
            }
        }

        console.log(`Current aily-blockly process count: ${count}`);

        if (count > 1) {
            console.log('Multiple instances detected. Skipping forced termination.');
            return;
        }

        exec(killCommand, (error, stdout, stderr) => {
            if (error) {
                const notFound =
                    (platform === 'win32' && stderr && stderr.includes('not found')) ||
                    (platform !== 'win32' && error.code === 1);
                if (notFound) {
                    console.log('No aily-blockly process found to terminate.');
                    return;
                }
                console.error(`Error killing aily-blockly process: ${error.message}`);
                return;
            }
            if (stdout) {
                console.log(`aily-blockly process terminated: ${stdout}`);
            }
        });
    } catch (commandError) {
        console.warn('Error attempting to kill aily-blockly process:', commandError.message);
    }
}

function registerWindowHandlers(mainWindow) {
    // 添加一个映射来存储已打开的窗口
    const openWindows = new Map();
    let codeViewerState = {
        code: '',
        selectedBlockId: null,
        blockCodeMap: [],
        updatedAt: 0,
    };

    const sendCodeViewerState = (targetWindow) => {
        try {
            if (targetWindow && !targetWindow.isDestroyed() && targetWindow.webContents && !targetWindow.webContents.isDestroyed()) {
                targetWindow.webContents.send(CODE_VIEWER_STATE_CHANNEL, codeViewerState);
            }
        } catch (error) {
            console.error('[IPC] send blockly code-viewer state failed:', error.message);
        }
    };

    const broadcastCodeViewerState = () => {
        sendCodeViewerState(mainWindow);
        openWindows.forEach((subWindow) => sendCodeViewerState(subWindow));
    };

    const loadSubWindowBasePage = (webContents) => {
        if (isDevServeSubWindow()) {
            webContents.loadURL('http://localhost:4200/');
        } else {
            webContents.loadFile('renderer/index.html');
        }
    };

    /**
     * @param {import('electron').BrowserWindow} subWindow
     * @param {string} windowUrl
     */
    const attachSubWindowLifecycleListeners = (subWindow, windowUrl) => {
        subWindow.on('enter-full-screen', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-full-screen-changed', true);
                }
            } catch (error) {
                console.error('Error sending sub-window-full-screen-changed:', error.message);
            }
        });

        subWindow.on('leave-full-screen', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-full-screen-changed', false);
                }
            } catch (error) {
                console.error('Error sending sub-window-full-screen-changed:', error.message);
            }
        });

        subWindow.on('maximize', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-maximize-changed', true);
                }
            } catch (error) {
                console.error('Error sending window-maximize-changed:', error.message);
            }
        });

        subWindow.on('unmaximize', () => {
            try {
                if (subWindow && subWindow.webContents) {
                    subWindow.webContents.send('window-maximize-changed', false);
                }
            } catch (error) {
                console.error('Error sending window-maximize-changed:', error.message);
            }
        });

        subWindow.on('closed', () => {
            openWindows.delete(windowUrl);
        });
    };

    mainWindow.on('focus', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-focus');
            }

        } catch (error) {
            console.error('Error sending window-focus:', error.message);
        }
    });

    mainWindow.on('blur', () => {
        // 检查窗口是否已销毁以及 webContents 是否有效
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-blur');
            }

        } catch (error) {
            console.error('Error sending window-blur:', error.message);
        }
    });

    mainWindow.on('enter-full-screen', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-full-screen-changed', true);
            }
        } catch (error) {
            console.error('Error sending window-full-screen-changed:', error.message);
        }
    });

    mainWindow.on('leave-full-screen', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-full-screen-changed', false);
            }
        } catch (error) {
            console.error('Error sending window-full-screen-changed:', error.message);
        }
    });

    // 为主窗口注册最大化/还原状态监听
    mainWindow.on('maximize', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-maximize-changed', true);
            }
        } catch (error) {
            console.error('Error sending window-maximize-changed:', error.message);
        }
    });

    mainWindow.on('unmaximize', () => {
        try {
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send('window-maximize-changed', false);
            }
        } catch (error) {
            console.error('Error sending window-maximize-changed:', error.message);
        }
    });


    ipcMain.on("window-open", (event, data) => {
        const windowUrl = data.path;
        const width = data.width ? data.width : 800;
        const height = data.height ? data.height : 600;
        const alwaysOnTop = data.alwaysOnTop ? data.alwaysOnTop : false;
        const needInitPayload = !!(data.data || data.url || data.title);

        // 检查是否已存在该URL的窗口
        if (openWindows.has(windowUrl)) {
            const existingWindow = openWindows.get(windowUrl);
            // 确保窗口仍然有效
            if (existingWindow && !existingWindow.isDestroyed()) {
                // 激活已存在的窗口
                existingWindow.focus();
                return;
            } else {
                // 如果窗口已被销毁，从映射中移除
                openWindows.delete(windowUrl);
            }
        }

        let subWindow = null;
        let fromPool = false;
        while (subWindowPool.length > 0) {
            const candidate = subWindowPool.shift();
            if (!candidate || candidate.isDestroyed()) {
                continue;
            }
            removePoolHandlersFromWin(candidate, loadSubWindowBasePage);
            subWindow = candidate;
            fromPool = true;
            break;
        }

        if (!subWindow) {
            subWindow = new BrowserWindow({
                frame: false,
                autoHideMenuBar: true,
                thickFrame: true,
                titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
                alwaysOnTop,
                width,
                height,
                webPreferences: getSubWindowWebPreferences(),
            });
        } else {
            try {
                subWindow.setAlwaysOnTop(!!alwaysOnTop);
                subWindow.setSize(width, height);
            } catch (e) {
                console.warn('[SubWindowPool] 应用子窗口尺寸/置顶失败:', e.message);
            }
        }

        openWindows.set(windowUrl, subWindow);
        attachSubWindowLifecycleListeners(subWindow, windowUrl);

        const sendInitToSubWindow = () => {
            if (needInitPayload) {
                subWindow.webContents.send('window-init-data', {
                    url: data.url,
                    title: data.title,
                    data: data.data,
                });
            }
        };

        const revealPooledSubWindow = () => {
            try {
                if (subWindow.isDestroyed()) {
                    return;
                }
                subWindow.setOpacity(1);
                subWindow.setSkipTaskbar(false);
                subWindow.show();
                subWindow.focus();
            } catch (e) {
                console.warn('[SubWindowPool] 显示子窗口失败:', e.message);
            }
        };

        if (fromPool) {
            let pooledRevealFinalized = false;
            const finalizePooledReveal = () => {
                if (pooledRevealFinalized || subWindow.isDestroyed()) {
                    return;
                }
                pooledRevealFinalized = true;
                sendInitToSubWindow();
                revealPooledSubWindow();
            };
            // 同文档/hash 导航可能只触发 did-navigate-in-page 而不触发 did-finish-load
            subWindow.webContents.once('did-finish-load', finalizePooledReveal);
            subWindow.webContents.once('did-navigate-in-page', finalizePooledReveal);
        } else if (needInitPayload) {
            subWindow.webContents.on('did-finish-load', () => {
                subWindow.webContents.send('window-init-data', {
                    url: data.url,
                    title: data.title,
                    data: data.data,
                });
            });
        }

        if (isDevServeSubWindow()) {
            subWindow.loadURL(`http://localhost:4200/#/${data.path}`);
        } else {
            subWindow.loadFile('renderer/index.html', { hash: `#/${data.path}` });
        }
    });

    ipcMain.on("window-minimize", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow) {
            senderWindow.minimize();
        }
    });

    ipcMain.on("window-maximize", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow && !senderWindow.isMaximized()) {
            senderWindow.maximize();
        }
    });

    ipcMain.on("window-close", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        // 检查是否是主窗口，如果是主窗口，关闭整个应用程序
        if (senderWindow === mainWindow) {
            app.quit();
            // Attempt to terminate any residual helper processes on exit.
            terminateAilyProcess();
        } else {
            senderWindow.close();
        }
    });

    // Mac 平台下处理系统关闭按钮的关闭检查
    if (process.platform === 'darwin') {
        mainWindow.on('close', (event) => {
            event.preventDefault();
            mainWindow.webContents.send('window-close-request');
        });

        // 监听渲染进程返回的关闭确认结果
        ipcMain.on('window-close-confirmed', (event) => {
            const senderWindow = BrowserWindow.fromWebContents(event.sender);
            if (senderWindow === mainWindow) {
                mainWindow.removeAllListeners('close');
                mainWindow.close();
                app.quit();
                terminateAilyProcess();
            }
        });
    }

    // 修改为同步处理程序
    ipcMain.on("window-is-maximized", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isMaximized = senderWindow ? senderWindow.isMaximized() : false;
        event.returnValue = isMaximized;
    });

    // 添加 unmaximize 处理程序
    ipcMain.on("window-unmaximize", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (senderWindow && senderWindow.isMaximized()) {
            senderWindow.unmaximize();
        }
    });

    // 监听获取全屏状态的请求
    ipcMain.handle('window-is-full-screen', (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        return senderWindow.isFullScreen();
    });

    // 检查窗口是否获得焦点（同步）
    ipcMain.on("window-is-focused", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isFocused = senderWindow ? senderWindow.isFocused() : false;
        event.returnValue = isFocused;
    });

    // 检查窗口是否最小化（同步）
    ipcMain.on("window-is-minimized", (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isMinimized = senderWindow ? senderWindow.isMinimized() : false;
        event.returnValue = isMinimized;
    });

    ipcMain.on("window-go-main", (event, data) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        mainWindow.webContents.send("window-go-main", data.replace('/', ''));
        senderWindow.close();
    });

    ipcMain.on("window-alwaysOnTop", (event, alwaysOnTop) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        senderWindow.setAlwaysOnTop(alwaysOnTop);
    });

    ipcMain.handle("window-send", (event, data) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (data.to == 'main') {
            // 创建唯一消息ID
            const messageId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
            // 创建Promise等待响应
            return new Promise((resolve) => {
                // 设置一次性监听器接收响应
                const responseListener = (event, response) => {
                    if (response.messageId === messageId) {
                        // 收到对应ID的响应，移除监听器并返回结果
                        ipcMain.removeListener('main-window-response', responseListener);
                        // console.log('window-send response', response);
                        resolve(response.data || "success");
                    }
                };
                // 注册监听器
                ipcMain.on('main-window-response', responseListener);
                // 发送消息到main窗口，带上messageId
                mainWindow.webContents.send("window-receive", {
                    form: senderWindow.id,
                    data: data.data,
                    messageId: messageId
                });
                // 自定义超时或默认9秒超时
                setTimeout(() => {
                    ipcMain.removeListener('main-window-response', responseListener);
                    resolve("timeout");
                }, data?.timeout || 9000);
            });
        }
        return true;
    });

    ipcMain.on(CODE_VIEWER_STATE_UPDATE_CHANNEL, (_event, data = {}) => {
        codeViewerState = {
            ...codeViewerState,
            ...data,
            updatedAt: Date.now(),
        };
        broadcastCodeViewerState();
    });

    ipcMain.handle(CODE_VIEWER_STATE_GET_CHANNEL, () => codeViewerState);

    // 用于sub窗口改变main窗口状态显示
    ipcMain.on('state-update', (event, data) => {
        console.log('state-update: ', data);
        mainWindow.webContents.send('state-update', data);
    });

    // =====================================================
    // iframe 模块 IPC 通讯（规范：iframe-message-{模块名}，参数 {type, data}）
    // =====================================================

    const IFRAME_CHANNEL_CONNECTION_GRAPH = 'iframe-message-connection-graph';

    ipcMain.on(IFRAME_CHANNEL_CONNECTION_GRAPH, (event, payload) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        const isFromMain = senderWindow && senderWindow.id === mainWindow.id;
        if (isFromMain) {
            // 主窗口 → 子窗口：广播给所有子窗口，由各模块按 type 自行处理（含 get-graph-data）
            openWindows.forEach((subWindow) => {
                try {
                    if (subWindow && !subWindow.isDestroyed() && subWindow.webContents && !subWindow.webContents.isDestroyed()) {
                        subWindow.webContents.send(IFRAME_CHANNEL_CONNECTION_GRAPH, payload);
                    }
                } catch (error) {
                    console.error('[IPC] 转发 iframe-message-connection-graph 失败:', error.message);
                }
            });
            // 嵌入模式：主窗口内的 connection-graph（如 blockly-editor 的 graph-editor tab）也会发送 get-graph-data，
            // 主窗口的 ConnectionGraphService 需要收到请求并响应，故主窗口发出的消息也需回传主窗口
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send(IFRAME_CHANNEL_CONNECTION_GRAPH, payload);
            }
        } else {
            // 子窗口 → 主窗口：转发给主窗口（含 get-graph-data）
            if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
                mainWindow.webContents.send(IFRAME_CHANNEL_CONNECTION_GRAPH, payload);
            }
        }
    });

    scheduleReplenishSubWindowPool(loadSubWindowBasePage);
}


module.exports = {
    registerWindowHandlers,
};
