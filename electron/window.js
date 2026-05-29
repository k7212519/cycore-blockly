// 窗口控制
const { ipcMain, BrowserWindow, app, screen } = require("electron");
const { exec, execSync } = require('child_process');
const path = require('path');

const CODE_VIEWER_STATE_CHANNEL = 'blockly-code-viewer-state';
const CODE_VIEWER_STATE_UPDATE_CHANNEL = 'blockly-code-viewer-state-update';
const CODE_VIEWER_STATE_GET_CHANNEL = 'blockly-code-viewer-state-get';

/** 后台预缓冲子窗口数量：1 个待用 + 1 个备用 */
const SUB_WINDOW_POOL_SIZE = 2;

/** 首次 before-quit 即置位；池窗口 closed 时 Electron 的 app.isQuitting 在实测中仍为 false */
let applicationIsQuitting = false;
app.once('before-quit', () => {
    applicationIsQuitting = true;
});

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
    if (applicationIsQuitting) {
        return;
    }
    if (subWindowReplenishScheduled) {
        return;
    }
    subWindowReplenishScheduled = true;
    setImmediate(() => {
        subWindowReplenishScheduled = false;
        if (applicationIsQuitting) {
            return;
        }
        replenishSubWindowPool(loadBasePage);
    });
}

/**
 * 创建不可见（opacity 0）、不出现在任务栏的预缓冲子窗口并完成首屏加载。
 * Windows 上不可设 transparent: true，否则会禁用 thickFrame 带来的边缘吸附与标题栏双击最大化。
 */
function pushPooledSubWindow(loadBasePage) {
    if (applicationIsQuitting) {
        return;
    }
    try {
        const win = new BrowserWindow({
            frame: false,
            show: false,
            opacity: 0,
            skipTaskbar: true,
            autoHideMenuBar: true,
            thickFrame: true,
            titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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
            if (!applicationIsQuitting) {
                scheduleReplenishSubWindowPool(loadBasePage);
            }
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
    if (applicationIsQuitting) {
        return;
    }
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

/**
 * 将子窗口居中到「主窗口当前所在显示器」的工作区内（多屏跟随主窗口）。
 * @param {import('electron').BrowserWindow} subWindow
 * @param {import('electron').BrowserWindow | null} mainWin
 * @param {number} width
 * @param {number} height
 */
function centerSubWindowOnMainDisplay(subWindow, mainWin, width, height) {
    try {
        if (!subWindow || subWindow.isDestroyed()) {
            return;
        }
        const wa =
            mainWin && !mainWin.isDestroyed()
                ? screen.getDisplayMatching(mainWin.getBounds()).workArea
                : screen.getPrimaryDisplay().workArea;
        const w = Math.min(Math.max(1, width), wa.width);
        const h = Math.min(Math.max(1, height), wa.height);
        const x = Math.round(wa.x + Math.max(0, (wa.width - w) / 2));
        const y = Math.round(wa.y + Math.max(0, (wa.height - h) / 2));
        subWindow.setBounds({ x, y, width: w, height: h });
    } catch (e) {
        console.warn('[SubWindowPool] 子窗口居中定位失败:', e.message);
    }
}

function terminateAilyProcess() {
    console.info('[PROC_TRACE][APP_NAME_KILL_DISABLED]');
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
        /** 池中仅占位，不加载 SPA 根页，避免出现 index / 首页再切目标页的闪屏；正式打开时再 load 路由 */
        webContents.loadURL('about:blank');
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
            // 仅清除本功能设置的 Dock 角标，避免覆盖其它模块可能的徽章
            if (process.platform === 'darwin' && app.dock && typeof app.dock.getBadge === 'function') {
                try {
                    if (app.dock.getBadge() === '!') {
                        app.dock.setBadge('');
                    }
                } catch (_e) { /* dock API 不可用时忽略 */ }
            }
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
            } catch (e) {
                console.warn('[SubWindowPool] 子窗口置顶设置失败:', e.message);
            }
        }

        centerSubWindowOnMainDisplay(subWindow, mainWindow, width, height);

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

    /**
     * 在应用处于后台时请求用户注意：任务栏闪烁（Windows）、Dock 弹跳与角标（macOS）。
     * 与系统通知配合，解决「通知一闪而过不易察觉」的问题。
     */
    ipcMain.handle('window-request-attention', (event) => {
        const senderWindow = BrowserWindow.fromWebContents(event.sender);
        if (!senderWindow || senderWindow.isDestroyed()) {
            return { success: false, error: 'no-window' };
        }
        try {
            if (process.platform === 'win32') {
                // 获得焦点前会持续闪烁任务栏按钮
                senderWindow.flashFrame(true);
            } else if (process.platform === 'darwin' && app.dock) {
                app.dock.bounce('informational');
                app.dock.setBadge('!');
            } else if (process.platform === 'linux') {
                if (typeof senderWindow.flashFrame === 'function') {
                    senderWindow.flashFrame(true);
                }
            }
            return { success: true };
        } catch (err) {
            console.warn('[window-request-attention]', err.message);
            return { success: false, error: err.message };
        }
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
