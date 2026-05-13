const { spawn, exec } = require('child_process');
const { ipcMain } = require('electron');
const path = require('path');
const { isWin32, isDarwin, isLinux } = require('./platform');

function summarizeArgs(args = []) {
  return args.join(' ').slice(0, 1000);
}

function killRegisteredProcessTree(pid, label) {
  if (!pid) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    if (isWin32) {
      exec(`taskkill /PID ${pid} /T /F`, (error, stdout, stderr) => {
        const success = !error;
        console.info('[PROC_TRACE][PROCESS_TREE_KILL]', {
          label,
          pid,
          method: 'taskkill',
          success,
          durationMs: Date.now() - startedAt,
          error: error?.message || '',
          stderr: stderr?.trim?.() || ''
        });
        resolve(success);
      });
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.info('[PROC_TRACE][PROCESS_TREE_KILL]', {
        label,
        pid,
        method: 'SIGTERM',
        success: true,
        durationMs: Date.now() - startedAt
      });
      resolve(true);
    } catch (error) {
      console.warn('[PROC_TRACE][PROCESS_TREE_KILL]', {
        label,
        pid,
        method: 'SIGTERM',
        success: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error)
      });
      resolve(false);
    }
  });
}

function sendRendererLog(targetWebContents, detail, state = 'doing', mergeKey) {
  if (!targetWebContents || targetWebContents.isDestroyed()) {
    return;
  }

  const log = {
    detail,
    state
  };

  if (mergeKey) {
    log.mergeKey = mergeKey;
  }

  targetWebContents.send('window-receive', {
    data: {
      action: 'log',
      log
    }
  });
}

function sendCmdData(targetWebContents, channel, payload) {
  if (!targetWebContents || targetWebContents.isDestroyed()) {
    return;
  }

  targetWebContents.send(channel, payload);
}

function isNoisyNpmLogLine(line) {
  return /^(npm http|npm verbose|npm info ok\b)/i.test(line)
    || /^npm error\b/i.test(line)
    || /^>\s+@?[^\s@]+(?:\/[^\s@]+)?@[^\s]+\s+postinstall\b/i.test(line)
    || /^>\s+node\s+\.\/postinstall\.js\b/i.test(line)
    || /^(added|changed|removed|updated|audited)\s+\d+\s+packages?\s+in\s+/i.test(line)
    || /^up to date\s+in\s+/i.test(line);
}

function getProgressMergeKey(sourceId, line) {
  if (/^下载进度[:：]/i.test(line) || /^下载完成[:：]/i.test(line)) {
    return `${sourceId}:download-progress`;
  }

  if (/^解压进度[:：]/i.test(line)) {
    return `${sourceId}:extract-progress`;
  }

  return undefined;
}

function logCommandOutput(streamId, type, output, targetWebContents) {
  const lines = output.split(/\r\n|\n|\r/g).map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (isNoisyNpmLogLine(line)) {
      continue;
    }

    const message = line.length > 2000 ? `${line.slice(0, 2000)}...` : line;
    const mergeKey = getProgressMergeKey(streamId, message);
    if (type === 'stderr') {
      if (!mergeKey) {
        console.error(`[CMD][${streamId}] stderr: ${message}`);
      }
      sendRendererLog(targetWebContents, message, 'error', mergeKey);
    } else {
      if (!mergeKey) {
        console.log(`[CMD][${streamId}] stdout: ${message}`);
      }
      sendRendererLog(targetWebContents, message, 'doing', mergeKey);
    }
  }
}

class CommandManager {
  constructor() {
    this.processes = new Map(); // 存储进程
    this.streams = new Map(); // 存储流监听器
  }

  // 执行命令并返回流式数据
  executeCommand(options) {
    let { command, args = [], cwd, env, streamId } = options;
    
    // 根据平台选择正确的 shell
    let shell;
    if (isWin32) {
      // 使用绝对路径，避免 PATH 中找不到 powershell 导致 ENOENT
      const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      shell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    } else if (isDarwin) {
      shell = '/bin/zsh';
    } else if (isLinux) {
      shell = '/bin/bash';
    } else {
      shell = true; // 使用系统默认 shell
    }

    // 【核心修复】Windows 环境下的特殊处理
    if (isWin32) {
      // 1. 如果是 npm/npx 命令，强制加上 .cmd 后缀
      // 只有这样，spawn 才能准确找到可执行文件，不再依赖 Shell 的智能猜测
      if (command === 'npm') {
        command = 'npm.cmd';
      } else if (command === 'npx') {
        command = 'npx.cmd';
      }

      // 2. 对于 .cmd 命令，使用 CMD (shell: true) 而非 PowerShell
      // 因为 .cmd 本质是批处理，用 cmd.exe 运行是最原生、最稳的
      // 同时也避开了 PowerShell 执行策略 (ExecutionPolicy) 的干扰
      if (command.endsWith('.cmd') || command.endsWith('.bat')) {
        shell = true;
      }
    }

    // 为 npm install 命令自动添加 --foreground-scripts，确保 postinstall 输出可见
    const isNpmCmd = command === 'npm' || command === 'npm.cmd';
    const isInstallCmd = args.includes('install') || args.includes('i');
    const shouldLogOutput = isNpmCmd && isInstallCmd;
    if (isNpmCmd && isInstallCmd) {
      const hasForegroundScripts = args.some(arg => arg === '--foreground-scripts' || arg.startsWith('--foreground-scripts='));
      if (!hasForegroundScripts) {
        args = [...args, '--foreground-scripts'];
      }
    }

    // 打印执行命令的日志
    // When using a shell, quote arguments containing spaces to prevent path splitting
    if (shell) {
      args = args.map(arg => {
        if (arg.includes(' ') && !arg.startsWith('"') && !arg.startsWith("'")) {
          return `"${arg}"`;
        }
        return arg;
      });
    }

    const fullCommand = args.length > 0 ? `${command} ${args.join(' ')}` : command;
    console.log(`[CMD] 执行命令: ${fullCommand}`);
    console.log(`[CMD] 工作目录: ${cwd || process.cwd()}`);
    console.log(`[CMD] Shell: ${shell}`);
    
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      shell: shell,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const startedAt = Date.now();
    this.processes.set(streamId, {
      process: child,
      command,
      args,
      cwd: cwd || process.cwd(),
      shell,
      startedAt
    });
    console.info('[PROC_TRACE][CMD_SPAWN]', {
      streamId,
      pid: child.pid,
      command,
      args: summarizeArgs(args),
      cwd: cwd || process.cwd(),
      shell: String(shell)
    });

    // console.log("====child:" , child,{
    //   pid: child.pid,
    //   process: child
    // });

    return {
      pid: child.pid,
      process: child,
      shouldLogOutput
    };
  }

  // 终止进程
  killProcess(streamId) {
    const entry = this.processes.get(streamId);
    if (entry?.process) {
      console.info('[PROC_TRACE][CMD_KILL]', {
        streamId,
        pid: entry.process.pid,
        command: entry.command
      });
      void killRegisteredProcessTree(entry.process.pid, `cmd:${streamId}`);
      this.processes.delete(streamId);
      this.streams.delete(streamId);
      return true;
    }
    return false;
  }

  // 获取进程
  getProcess(streamId) {
    return this.processes.get(streamId)?.process;
  }

  getActiveProcessSummaries() {
    return Array.from(this.processes.entries()).map(([streamId, entry]) => ({
      streamId,
      pid: entry.process?.pid,
      command: entry.command,
      cwd: entry.cwd,
      durationMs: Date.now() - entry.startedAt
    }));
  }

  async killAllProcesses() {
    const entries = Array.from(this.processes.entries());
    console.info('[PROC_TRACE][CMD_KILL_ALL]', { count: entries.length, processes: this.getActiveProcessSummaries() });
    await Promise.all(entries.map(async ([streamId, entry]) => {
      await killRegisteredProcessTree(entry.process?.pid, `cmd:${streamId}`);
      this.processes.delete(streamId);
      this.streams.delete(streamId);
    }));
  }

    /**
   * 杀掉所有指定名称的进程
   * @param {string} processName - 要杀掉的进程名称，例如 'node.exe'
   */
  killProcessByName(processName) {
    console.warn('[PROC_TRACE][CMD_KILL_BY_NAME_BLOCKED]', { processName });
    return false;
  }
}

const commandManager = new CommandManager();

function registerCmdHandlers(mainWindow) {
  // 执行命令
  ipcMain.handle('cmd-run', async (event, options) => {
    const streamId = options.streamId || `cmd_${Date.now()}_${Math.random()}`;
    const senderWindow = event.sender; // 获取发送请求的窗口

    try {
      const result = commandManager.executeCommand({ ...options, streamId });
      const process = result.process;
      // console.log(options);
      // 监听标准输出
      process.stdout.on('data', (data) => {
        const output = data.toString();
        if (result.shouldLogOutput) {
          logCommandOutput(streamId, 'stdout', output, senderWindow);
        }
        sendCmdData(senderWindow, `cmd-data-${streamId}`, {
          type: 'stdout',
          data: output,
          streamId
        });
      });

      // 监听错误输出
      process.stderr.on('data', (data) => {
        const output = data.toString();
        if (result.shouldLogOutput) {
          logCommandOutput(streamId, 'stderr', output, senderWindow);
        }
        sendCmdData(senderWindow, `cmd-data-${streamId}`, {
          type: 'stderr',
          data: output,
          streamId
        });
      });

      // 监听进程关闭
      process.on('close', (code, signal) => {
        const entry = commandManager.processes.get(streamId);
        console.log(`[CMD][${streamId}] close, code: ${code}, signal: ${signal}`);
        console.info('[PROC_TRACE][CMD_CLOSE]', {
          streamId,
          pid: process.pid,
          code,
          signal,
          durationMs: entry ? Date.now() - entry.startedAt : undefined
        });
        sendCmdData(senderWindow, `cmd-data-${streamId}`, {
          type: 'close',
          code,
          signal,
          streamId
        });
        commandManager.processes.delete(streamId);
      });

      // 监听进程错误
      process.on('error', (error) => {
        const entry = commandManager.processes.get(streamId);
        console.error(`[CMD][${streamId}] error: ${error.message}`);
        console.error('[PROC_TRACE][CMD_ERROR]', {
          streamId,
          pid: process.pid,
          error: error.message,
          durationMs: entry ? Date.now() - entry.startedAt : undefined
        });
        sendCmdData(senderWindow, `cmd-data-${streamId}`, {
          type: 'error',
          error: error.message,
          streamId
        });
        commandManager.processes.delete(streamId);
      });

      return {
        success: true,
        streamId,
        pid: result.pid
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        streamId
      };
    }
  });

  // 终止命令
  ipcMain.handle('cmd-kill', async (event, { streamId }) => {
    const success = commandManager.killProcess(streamId);
    return { success, streamId };
  });

  // 终止指定名称的进程
  ipcMain.handle('cmd-kill-by-name', async (event, { processName }) => {
    console.warn('[PROC_TRACE][CMD_KILL_BY_NAME_BLOCKED]', { processName });
    return { success: false, error: 'Killing processes by name is disabled. Use a registered streamId instead.' };
  });

  // 向进程发送输入
  ipcMain.handle('cmd-input', async (event, { streamId, input }) => {
    const process = commandManager.getProcess(streamId);
    if (process && process.stdin) {
      process.stdin.write(input);
      return { success: true };
    }
    return { success: false, error: 'Process not found or stdin not available' };
  });
}

module.exports = {
  registerCmdHandlers,
  killAllCmdProcesses: () => commandManager.killAllProcesses(),
  getActiveCmdProcesses: () => commandManager.getActiveProcessSummaries()
};