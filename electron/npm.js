// 这个文件用于和npm交互，获取仓库信息
const { ipcMain } = require("electron");
const { spawn } = require('child_process');

function ensureForegroundScripts(cmd) {
    if (!/^npm(\.cmd)?\s+(install|i)\b/i.test(cmd)) {
        return cmd;
    }

    if (/\s--foreground-scripts(=\S+)?\b/i.test(cmd)) {
        return cmd;
    }

    return `${cmd} --foreground-scripts`;
}

function shouldLogStreamingOutput(cmd) {
    return /^npm(\.cmd)?\s+(install|i)\b/i.test(cmd);
}

function sendRendererLog(mainWindow, detail, state = 'doing') {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return;
    }

    mainWindow.webContents.send('window-receive', {
        data: {
            action: 'log',
            log: {
                detail,
                state
            }
        }
    });
}

function isNoisyNpmLogLine(line) {
    return /^(npm http|npm verbose|npm info ok\b)/i.test(line)
        || /^>\s+@?[^\s@]+(?:\/[^\s@]+)?@[^\s]+\s+postinstall\b/i.test(line)
        || /^>\s+node\s+\.\/postinstall\.js\b/i.test(line)
        || /^(added|changed|removed|updated|audited)\s+\d+\s+packages?\s+in\s+/i.test(line)
        || /^up to date\s+in\s+/i.test(line);
}

function logNpmOutput(type, output, mainWindow) {
    const lines = output.split(/\r\n|\n|\r/g).map(line => line.trim()).filter(Boolean);
    for (const line of lines) {
        if (isNoisyNpmLogLine(line)) {
            continue;
        }

        const message = line.length > 2000 ? `${line.slice(0, 2000)}...` : line;
        if (type === 'stderr') {
            console.error(`[NPM] stderr: ${message}`);
            sendRendererLog(mainWindow, message, 'error');
        } else {
            console.log(`[NPM] stdout: ${message}`);
            sendRendererLog(mainWindow, message, 'doing');
        }
    }
}

function registerNpmHandlers(mainWindow) {
    ipcMain.handle('npm-run', async (event, { cmd, option = {} }) => {
        cmd = ensureForegroundScripts(cmd);
        console.log('npm run cmd: ', cmd);
        return new Promise((resolve, reject) => {
            const child = spawn(cmd, {
                shell: true,
                windowsHide: true,
                env: process.env,
            });
            const shouldLogOutput = shouldLogStreamingOutput(cmd);
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                const output = data.toString();
                stdout += output;
                if (shouldLogOutput) {
                    logNpmOutput('stdout', output, mainWindow);
                }
            });

            child.stderr.on('data', (data) => {
                const output = data.toString();
                stderr += output;
                if (shouldLogOutput) {
                    logNpmOutput('stderr', output, mainWindow);
                }
            });

            child.on('error', (error) => {
                if (option?.ignoreErr) {
                    return resolve(false);
                }
                console.error(`执行命令出错: ${error}`);
                reject(error);
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    if (option?.ignoreErr) {
                        return resolve(false);
                    }
                    const error = new Error(stderr || `命令退出码 ${code}`);
                    console.error(`执行命令出错: ${error.message}`);
                    return reject(error);
                }
                if (stderr && !stdout) {
                    return reject(new Error(stderr));
                }
                try {
                    resolve(stdout);
                } catch (e) {
                    reject(new Error(e.message));
                }
            });
        })
    });
}

module.exports = {
    registerNpmHandlers,
};