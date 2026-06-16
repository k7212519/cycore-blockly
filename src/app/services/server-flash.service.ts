import { Injectable } from '@angular/core';
import { ProjectService } from './project.service';
import { EspLoaderService, FlashFile, TerminalHandler } from './esploader.service';
import { NoticeService } from './notice.service';
import { LogService } from './log.service';
import { ActionState } from './ui.service';
import { SerialService } from './serial.service';

@Injectable({
  providedIn: 'root'
})
export class ServerFlashService {

  constructor(
    private projectService: ProjectService,
    private espLoaderService: EspLoaderService,
    private noticeService: NoticeService,
    private logService: LogService,
    private serialService: SerialService
  ) { }

  cancel(): void {
    this.espLoaderService.requestCancel();
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
      fileArray.push({
        address: file.address,
        data: this.arrayBufferToBinaryString(buffer)
      });
    }

    const totalBytes = fileArray.reduce((sum, item) => sum + item.data.length, 0);
    const terminalHandler: TerminalHandler = {
      write: text => this.logService.update({ detail: text }),
      writeLine: text => this.logService.update({ detail: text }),
      clean: () => { }
    };

    this.noticeService.update({
      title: '上传中',
      text: '正在连接开发板',
      state: 'doing',
      progress: 5,
      setTimeout: 0,
      stop: () => this.cancel()
    });

    const initialized = await this.espLoaderService.initializeWithPort(serialPort, 921600, terminalHandler);
    if (!initialized) {
      throw new Error('连接开发板失败，请确认串口权限和开发板状态');
    }

    try {
      await this.espLoaderService.flash({
        fileArray,
        flashSize: 'keep',
        compress: true,
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
      await this.espLoaderService.resetDevice(1000);
      this.noticeService.update({
        title: '上传完成',
        text: '上传完成',
        state: 'done',
        progress: 100,
        setTimeout: 55000
      });
      return { state: 'done', text: '上传完成' };
    } finally {
      await this.espLoaderService.disconnect();
    }
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
