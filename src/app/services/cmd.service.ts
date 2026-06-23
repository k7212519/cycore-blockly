import { Injectable } from '@angular/core';
import { Observable, of } from 'rxjs';
import { LogService } from './log.service';

export interface CmdOutput {
  type: 'stdout' | 'stderr' | 'close' | 'error';
  data?: string;
  code?: number;
  signal?: string;
  error?: string;
  streamId: string;
}

export interface CmdOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  streamId?: string;
}

/**
 * 浏览器不能直接启动本机进程。
 *
 * 编译、上传和依赖管理应走服务端接口；保留这个服务的接口只为让尚未迁移完的
 * 调用点得到明确错误，而不是尝试访问桌面预加载对象。
 */
@Injectable({ providedIn: 'root' })
export class CmdService {
  constructor(private logService: LogService) {}

  spawn(command: string, args: string[] = [], options: Partial<CmdOptions> = {}): Observable<CmdOutput> {
    return this.unsupported([command, ...args].join(' '), options.streamId);
  }

  run(command: string, _cwd?: string, _useQueue = true): Observable<CmdOutput> {
    return this.unsupported(command);
  }

  async runAsync(command: string, _cwd?: string, _useQueue = true): Promise<CmdOutput> {
    return this.createUnsupportedOutput(command);
  }

  async kill(_streamId: string): Promise<boolean> {
    return false;
  }

  async killByName(_processName: string): Promise<boolean> {
    return false;
  }

  clearQueue(): void {}

  getQueueLength(): number {
    return 0;
  }

  isProcessing(): boolean {
    return false;
  }

  async sendInput(_streamId: string, _input: string): Promise<boolean> {
    return false;
  }

  private unsupported(command: string, streamId?: string): Observable<CmdOutput> {
    return of(this.createUnsupportedOutput(command, streamId));
  }

  private createUnsupportedOutput(command: string, streamId?: string): CmdOutput {
    const error = '浏览器环境不支持执行本机命令，请使用服务端编译、上传或依赖管理接口';
    this.logService.update({
      title: '命令不可用',
      detail: `${error}: ${command}`,
      state: 'error'
    });
    return {
      type: 'error',
      code: 1,
      error,
      data: error,
      streamId: streamId || `browser_cmd_${Date.now()}`
    };
  }
}
