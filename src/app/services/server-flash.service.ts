import { Injectable } from '@angular/core';
import { ProjectService } from './project.service';
import { EspLoaderService, FlashFile, TerminalHandler } from './esploader.service';
import { NoticeService } from './notice.service';
import { LogService } from './log.service';
import { ActionState } from './ui.service';
import { SerialService } from './serial.service';
import { ProcessState, WorkflowService } from './workflow.service';

@Injectable({
  providedIn: 'root'
})
export class ServerFlashService {
  private cancelled = false;
  private running = false;

  constructor(
    private projectService: ProjectService,
    private espLoaderService: EspLoaderService,
    private noticeService: NoticeService,
    private logService: LogService,
    private serialService: SerialService,
    private workflowService: WorkflowService
  ) { }

  cancel(): void {
    this.cancelled = true;
    this.espLoaderService.requestCancel();
    if (this.workflowService.currentState === ProcessState.UPLOADING) {
      this.workflowService.cancelCurrent('上传已取消');
    }
    this.noticeService.update({
      title: '上传已取消',
      text: '上传已取消',
      state: 'warn',
      setTimeout: 5000,
    });
  }

  async flashLastCompile(serialPortInput: any): Promise<ActionState> {
    const compileResult = this.projectService.lastServerCompileResult;
    const flashFiles = compileResult?.flashFiles || [];
    if (!compileResult?.success || flashFiles.length === 0) {
      throw new Error('未找到可烧录的服务端编译产物，请先编译项目');
    }

    let serialPort = serialPortInput?.port || serialPortInput;
    if (typeof serialPort === 'string') {
      serialPort = this.serialService.getBrowserPort(serialPort);
    }
    if (!serialPort) {
      throw new Error('请先选择串口');
    }
    if (this.running) {
      const error = new Error('上一次烧录正在终止') as Error & { state: 'warn'; text: string };
      error.state = 'warn';
      error.text = '上一次烧录正在终止';
      throw error;
    }

    this.running = true;
    this.cancelled = false;

    try {
      return await this.performFlash(serialPort, flashFiles);
    } finally {
      this.running = false;
    }
  }

  private async performFlash(serialPort: any, flashFiles: any[]): Promise<ActionState> {
    this.noticeService.update({
      title: '上传中',
      text: '正在下载固件',
      state: 'doing',
      progress: 0,
      setTimeout: 0,
      stop: () => this.cancel()
    });

    const fileArray: FlashFile[] = [];
    for (const file of flashFiles) {
      const buffer = await this.projectService.downloadServerArtifactFile(file);
      this.throwIfCancelled();
      fileArray.push({
        address: file.address,
        data: this.arrayBufferToBinaryString(buffer)
      });
    }

    const uploadConfig = await this.getUploadConfig();
    const totalBytes = fileArray.reduce((sum, item) => sum + item.data.length, 0);
    const terminalHandler: TerminalHandler = {
      write: text => this.logService.update({ detail: text }),
      writeLine: text => this.logService.update({ detail: text }),
      clean: () => { }
    };

    this.noticeService.update({
      title: '上传中',
      text: `正在连接开发板 (${uploadConfig.baudRate})`,
      state: 'doing',
      progress: 5,
      setTimeout: 0,
      stop: () => this.cancel()
    });

    try {
      const initialized = await this.espLoaderService.initializeWithPort(
        serialPort,
        uploadConfig.baudRate,
        terminalHandler,
        uploadConfig.beforeReset
      );
      this.throwIfCancelled();
      if (!initialized) {
        throw new Error('连接开发板失败，请确认串口权限和开发板状态');
      }

      const flashSucceeded = await this.espLoaderService.flash({
        fileArray,
        flashSize: uploadConfig.flashSize,
        flashMode: uploadConfig.flashMode,
        flashFreq: uploadConfig.flashFreq,
        eraseAll: uploadConfig.eraseAll,
        compress: uploadConfig.compress,
        reportProgress: (fileIndex, written) => {
          const completedBefore = fileArray
            .slice(0, fileIndex)
            .reduce((sum, item) => sum + item.data.length, 0);
          const progress = totalBytes > 0
            ? Math.min(99, Math.floor(((completedBefore + written) / totalBytes) * 100))
            : 0;
          this.noticeService.update({
            title: '上传中',
            text: '正在烧录固件',
            state: 'doing',
            progress,
            setTimeout: 0,
            stop: () => this.cancel()
          });
        }
      });
      this.throwIfCancelled();
      if (!flashSucceeded) {
        throw new Error('烧录固件失败，请检查串口连接和开发板状态');
      }
      this.noticeService.update({
        title: '上传中',
        text: '正在重启开发板',
        state: 'doing',
        progress: 99,
        setTimeout: 0,
        stop: () => this.cancel()
      });
      await this.espLoaderService.after(uploadConfig.afterReset);
      this.throwIfCancelled();
      this.noticeService.update({
        title: '上传完成',
        text: '上传完成',
        state: 'done',
        progress: 100,
        setTimeout: 55000
      });
      return { state: 'done', text: '上传完成' };
    } catch (error: any) {
      if (this.cancelled || error?.message?.includes('用户取消')) {
        throw this.createCancelledError();
      }
      throw error;
    } finally {
      await this.espLoaderService.disconnect();
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) {
      throw this.createCancelledError();
    }
  }

  private createCancelledError(): Error & { state: 'warn'; text: string } {
    const error = new Error('上传已取消') as Error & { state: 'warn'; text: string };
    error.state = 'warn';
    error.text = '上传已取消';
    return error;
  }

  private async getUploadConfig(): Promise<BrowserUploadConfig> {
    const packageJson = await this.projectService.getPackageJson();
    const projectConfig = packageJson?.projectConfig || {};

    return {
      baudRate: this.toNumber(projectConfig.UploadSpeed, 921600),
      beforeReset: this.toBeforeReset(projectConfig.UploadMode || projectConfig.BeforeReset),
      afterReset: this.toAfterReset(projectConfig.AfterReset),
      flashMode: this.toFlashMode(projectConfig.FlashMode),
      flashFreq: this.toFlashFreq(projectConfig.FlashFreq),
      flashSize: this.toFlashSize(projectConfig.FlashSize),
      eraseAll: this.toBoolean(projectConfig.EraseFlash, false),
      compress: this.toBoolean(projectConfig.CompressUpload, true)
    };
  }

  private toNumber(value: any, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private toBeforeReset(value: any): BrowserUploadConfig['beforeReset'] {
    const normalized = String(value || 'default_reset');
    if (['default_reset', 'usb_reset', 'no_reset', 'no_reset_no_sync'].includes(normalized)) {
      return normalized as BrowserUploadConfig['beforeReset'];
    }
    return 'default_reset';
  }

  private toAfterReset(value: any): BrowserUploadConfig['afterReset'] {
    const normalized = String(value || 'hard_reset');
    if (['hard_reset', 'soft_reset', 'no_reset', 'no_reset_stub'].includes(normalized)) {
      return normalized as BrowserUploadConfig['afterReset'];
    }
    return 'hard_reset';
  }

  private toFlashMode(value: any): string {
    const normalized = String(value || 'keep').toLowerCase();
    return ['keep', 'qio', 'qout', 'dio', 'dout'].includes(normalized) ? normalized : 'keep';
  }

  private toFlashFreq(value: any): string {
    const normalized = String(value || 'keep').toLowerCase().replace('mhz', 'm');
    return ['keep', '40m', '26m', '20m', '80m'].includes(normalized) ? normalized : 'keep';
  }

  private toFlashSize(value: any): string {
    const normalized = String(value || 'keep').toUpperCase();
    if (normalized === 'KEEP') {
      return 'keep';
    }
    return ['1MB', '2MB', '4MB', '8MB', '16MB'].includes(normalized) ? normalized : 'keep';
  }

  private toBoolean(value: any, fallback: boolean): boolean {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    return ['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(String(value).toLowerCase());
  }

  private arrayBufferToBinaryString(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let result = '';
    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      result += String.fromCharCode(...chunk);
    }
    return result;
  }
}

interface BrowserUploadConfig {
  baudRate: number;
  beforeReset: 'default_reset' | 'usb_reset' | 'no_reset' | 'no_reset_no_sync';
  afterReset: 'hard_reset' | 'soft_reset' | 'no_reset' | 'no_reset_stub';
  flashMode: string;
  flashFreq: string;
  flashSize: string;
  eraseAll: boolean;
  compress: boolean;
}
