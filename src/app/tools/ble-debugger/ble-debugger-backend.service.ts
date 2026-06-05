import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';

export interface BleDebuggerDevice {
  id: string;
  uuid?: string;
  address?: string;
  addressType?: string;
  name: string;
  localName?: string;
  rssi: number | null;
  connectable: boolean;
  serviceUuids: string[];
  manufacturerData?: string;
  txPowerLevel?: number | null;
}

export interface BleGattCharacteristic {
  uuid: string;
  rawUuid: string;
  serviceUuid: string;
  rawServiceUuid: string;
  properties: string[];
  lastValueHex?: string;
  lastValueAscii?: string;
  notifying?: boolean;
}

export interface BleGattService {
  uuid: string;
  rawUuid: string;
  characteristics: BleGattCharacteristic[];
}

export interface BleBackendEvent {
  event: string;
  data?: any;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface BackendMessage {
  id?: number;
  ok?: boolean;
  data?: any;
  error?: string;
  event?: string;
}

@Injectable({
  providedIn: 'root'
})
export class BleDebuggerBackendService implements OnDestroy {
  readonly events$ = new Subject<BleBackendEvent>();

  private streamId = '';
  private stdoutBuffer = '';
  private requestSeq = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private removeListener: (() => void) | null = null;
  private startPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((reason?: any) => void) | null = null;
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.startBackend();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async request<T = any>(action: string, data: Record<string, any> = {}, timeoutMs = 15000): Promise<T> {
    await this.start();

    if (!this.streamId) {
      throw new Error('BLE debugger backend is not running');
    }

    const id = ++this.requestSeq;
    const payload = JSON.stringify({ id, action, ...data }) + '\n';

    const response = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`BLE backend request timed out: ${action}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeout });
    });

    const result = await window['cmd'].input(this.streamId, payload);
    if (!result?.success) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
      }
      throw new Error(result?.error || 'Failed to write to BLE debugger backend');
    }

    return response;
  }

  async stop(): Promise<void> {
    if (!this.streamId && !this.running) {
      return;
    }

    const streamId = this.streamId;
    try {
      if (streamId && this.running) {
        await this.request('shutdown', {}, 1200).catch(() => undefined);
      }
    } finally {
      if (streamId) {
        await window['cmd']?.kill?.(streamId).catch?.(() => undefined);
      }
      this.handleClose();
    }
  }

  ngOnDestroy(): void {
    void this.stop();
    this.events$.complete();
  }

  private async startBackend(): Promise<void> {
    const cmd = window['cmd'];
    const pathApi = window['path'];
    const fsApi = window['fs'];

    if (!cmd?.run || !cmd?.onData || !cmd?.input) {
      throw new Error('Electron command bridge is not available');
    }

    if (!pathApi?.getAilyChildPath || !pathApi?.join) {
      throw new Error('Aily child path API is not available');
    }

    const childPath = pathApi.getAilyChildPath();
    const projectPath = pathApi.join(childPath, 'ble-debugger');
    const scriptPath = pathApi.join(projectPath, 'index.js');
    const noblePackagePath = pathApi.join(projectPath, 'node_modules', '@abandonware', 'noble', 'package.json');

    if (fsApi?.existsSync && !fsApi.existsSync(scriptPath)) {
      throw new Error(`BLE debugger backend was not found: ${scriptPath}`);
    }

    if (fsApi?.existsSync && !fsApi.existsSync(noblePackagePath)) {
      throw new Error('BLE debugger backend dependencies are missing. Run npm run install:ble-debugger in the project root.');
    }

    this.streamId = `ble_debugger_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    this.stdoutBuffer = '';

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyResolve = null;
        this.readyReject = null;
        reject(new Error('BLE debugger backend did not report ready'));
      }, 8000);
      this.readyResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      this.readyReject = (reason?: any) => {
        clearTimeout(timeout);
        reject(reason);
      };
    });

    this.removeListener = cmd.onData(this.streamId, (output: any) => {
      this.handleProcessOutput(output);
    });

    const result = await cmd.run({
      command: 'node',
      args: [scriptPath],
      cwd: projectPath,
      streamId: this.streamId,
      env: {
        AILY_BLE_DEBUGGER: '1'
      }
    });

    if (!result?.success) {
      this.handleClose();
      throw new Error(result?.error || 'Failed to start BLE debugger backend');
    }

    await readyPromise;
    this.running = true;
  }

  private handleProcessOutput(output: any): void {
    if (!output) return;

    if (output.type === 'stdout' && output.data) {
      this.consumeStdout(output.data);
      return;
    }

    if (output.type === 'stderr' && output.data) {
      this.emitLog('stderr', output.data);
      return;
    }

    if (output.type === 'error') {
      this.rejectReady(output.error || 'BLE debugger backend process error');
      this.emitEvent('error', { message: output.error || 'BLE debugger backend process error' });
      this.handleClose();
      return;
    }

    if (output.type === 'close') {
      this.rejectReady(`BLE debugger backend closed with code ${output.code ?? 'unknown'}`);
      this.emitEvent('close', { code: output.code, signal: output.signal });
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
        this.emitLog('stdout', trimmed);
      }
    }
  }

  private handleBackendMessage(message: BackendMessage): void {
    if (typeof message.id === 'number') {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);

      if (message.ok) {
        pending.resolve(message.data);
      } else {
        pending.reject(new Error(message.error || 'BLE backend request failed'));
      }
      return;
    }

    if (message.event === 'ready') {
      this.emitEvent('ready', message.data || {});
      this.resolveReady();
      return;
    }

    if (message.event === 'fatal') {
      const error = message.data?.message || 'BLE debugger backend fatal error';
      this.emitEvent('fatal', { message: error });
      this.rejectReady(error);
      return;
    }

    if (message.event) {
      this.emitEvent(message.event, message.data || {});
    }
  }

  private resolveReady(): void {
    const resolve = this.readyResolve;
    this.readyResolve = null;
    this.readyReject = null;
    resolve?.();
  }

  private rejectReady(reason: any): void {
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    reject?.(reason instanceof Error ? reason : new Error(String(reason)));
  }

  private emitEvent(event: string, data: any = {}): void {
    this.events$.next({ event, data });
  }

  private emitLog(source: 'stdout' | 'stderr', text: string): void {
    for (const line of text.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
      this.emitEvent('log', { level: source, message: line });
    }
  }

  private handleClose(): void {
    if (this.removeListener) {
      this.removeListener();
      this.removeListener = null;
    }

    this.running = false;
    this.streamId = '';
    this.stdoutBuffer = '';

    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('BLE debugger backend is closed'));
      this.pendingRequests.delete(id);
    }
  }
}
