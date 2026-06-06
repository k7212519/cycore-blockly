import { Injectable, OnDestroy } from '@angular/core';

export interface BleDebuggerHostInfo {
  url: string;
  origin?: string;
  wsUrl?: string;
  shutdownUrl?: string;
  port?: number;
  pid?: number;
}

interface BackendMessage {
  event?: string;
  data?: any;
}

@Injectable({
  providedIn: 'root'
})
export class BleDebuggerBackendService implements OnDestroy {
  private streamId = '';
  private stdoutBuffer = '';
  private removeListener: (() => void) | null = null;
  private startPromise: Promise<BleDebuggerHostInfo> | null = null;
  private readyResolve: ((value: BleDebuggerHostInfo) => void) | null = null;
  private readyReject: ((reason?: any) => void) | null = null;
  private running = false;
  private hostInfo: BleDebuggerHostInfo | null = null;

  get isRunning(): boolean {
    return this.running;
  }

  get info(): BleDebuggerHostInfo | null {
    return this.hostInfo;
  }

  async start(): Promise<BleDebuggerHostInfo> {
    if (this.running && this.hostInfo) {
      return this.hostInfo;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startServer();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    const streamId = this.streamId;
    if (!streamId && !this.running) {
      return;
    }

    try {
      if (streamId) {
        await window['cmd']?.kill?.(streamId);
      }
    } finally {
      this.handleClose();
    }
  }

  ngOnDestroy(): void {
    void this.stop();
  }

  private async startServer(): Promise<BleDebuggerHostInfo> {
    const cmd = window['cmd'];
    const pathApi = window['path'];
    const fsApi = window['fs'];

    if (!cmd?.run || !cmd?.onData) {
      throw new Error('Electron command bridge is not available');
    }

    if (!pathApi?.getAilyChildPath || !pathApi?.join) {
      throw new Error('Aily child path API is not available');
    }

    const childPath = pathApi.getAilyChildPath();
    const projectPath = pathApi.join(childPath, 'ble-debugger');
    const scriptPath = pathApi.join(projectPath, 'index.js');
    const noblePackagePath = pathApi.join(projectPath, 'node_modules', '@abandonware', 'noble', 'package.json');
    const wsPackagePath = pathApi.join(projectPath, 'node_modules', 'ws', 'package.json');
    const uiPath = pathApi.join(projectPath, 'ui', 'index.html');

    if (fsApi?.existsSync && !fsApi.existsSync(scriptPath)) {
      throw new Error(`BLE debugger backend was not found: ${scriptPath}`);
    }

    if (fsApi?.existsSync && !fsApi.existsSync(uiPath)) {
      throw new Error(`BLE debugger UI was not found: ${uiPath}`);
    }

    if (fsApi?.existsSync && (!fsApi.existsSync(noblePackagePath) || !fsApi.existsSync(wsPackagePath))) {
      throw new Error('BLE debugger dependencies are missing. Run npm run install:ble-debugger in the project root.');
    }

    this.streamId = `ble_debugger_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.stdoutBuffer = '';

    const readyPromise = new Promise<BleDebuggerHostInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyResolve = null;
        this.readyReject = null;
        reject(new Error('BLE debugger server did not report ready'));
      }, 8000);
      this.readyResolve = value => {
        clearTimeout(timeout);
        resolve(value);
      };
      this.readyReject = reason => {
        clearTimeout(timeout);
        reject(reason);
      };
    });

    this.removeListener = cmd.onData(this.streamId, (output: any) => {
      this.handleProcessOutput(output);
    });

    const result = await cmd.run({
      command: 'node',
      args: [scriptPath, 'serve', '--host', '127.0.0.1', '--port', '0'],
      cwd: projectPath,
      streamId: this.streamId,
      env: {
        AILY_BLE_DEBUGGER: '1'
      }
    });

    if (!result?.success) {
      this.handleClose();
      throw new Error(result?.error || 'Failed to start BLE debugger server');
    }

    return await readyPromise;
  }

  private handleProcessOutput(output: any): void {
    if (!output) return;

    if (output.type === 'stdout' && output.data) {
      this.consumeStdout(output.data);
      return;
    }

    if (output.type === 'error') {
      this.rejectReady(output.error || 'BLE debugger server process error');
      this.handleClose();
      return;
    }

    if (output.type === 'close') {
      this.rejectReady(`BLE debugger server closed with code ${output.code ?? 'unknown'}`);
      this.handleClose();
    }
  }

  private consumeStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.handleBackendMessage(JSON.parse(trimmed));
      } catch {
        // Non-JSON output is ignored here; the child UI owns BLE logs now.
      }
    }
  }

  private handleBackendMessage(message: BackendMessage): void {
    if (message.event === 'ready' && message.data?.url) {
      this.hostInfo = message.data as BleDebuggerHostInfo;
      this.running = true;
      this.resolveReady(this.hostInfo);
      return;
    }

    if (message.event === 'fatal') {
      const error = message.data?.message || 'BLE debugger server fatal error';
      this.rejectReady(error);
    }
  }

  private resolveReady(value: BleDebuggerHostInfo): void {
    const resolve = this.readyResolve;
    this.readyResolve = null;
    this.readyReject = null;
    resolve?.(value);
  }

  private rejectReady(reason: any): void {
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    reject?.(reason instanceof Error ? reason : new Error(String(reason)));
  }

  private handleClose(): void {
    if (this.removeListener) {
      this.removeListener();
      this.removeListener = null;
    }

    this.running = false;
    this.streamId = '';
    this.stdoutBuffer = '';
    this.hostInfo = null;
  }
}
