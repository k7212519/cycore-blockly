import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ActionService } from '../../../services/action.service';
import { LogService } from '../../../services/log.service';
import { NoticeService } from '../../../services/notice.service';
import { ProjectService } from '../../../services/project.service';
import { ActionState } from '../../../services/ui.service';
import { ProcessState, WorkflowService } from '../../../services/workflow.service';
import { arduinoGenerator } from '../components/blockly/generators/arduino/arduino';
import { BlocklyService } from './blockly.service';
import { _ProjectService } from './project.service';

@Injectable()
export class _BuilderService {
  currentProjectPath = '';
  lastCode = '';
  passed = false;
  cancelled = false;
  isUploading = false;
  buildInProgress = false;

  private initialized = false;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private message: NzMessageService,
    private noticeService: NoticeService,
    private logService: LogService,
    private workflowService: WorkflowService,
    private actionService: ActionService,
    private projectService: ProjectService,
    private blocklyProjectService: _ProjectService,
    private blocklyService: BlocklyService,
  ) {}

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.actionService.listen('compile-begin', async () => {
      try {
        return { success: true, result: await this.build() };
      } catch (result) {
        return { success: false, result };
      }
    }, 'builder-compile-begin');
    this.actionService.listen('compile-cancel', () => this.cancel(), 'builder-compile-cancel');
    this.actionService.listen('compile-reset', () => {
      this.passed = false;
      this.lastCode = '';
    }, 'builder-compile-reset');
    this.actionService.listen('preprocess-stop', () => ({ success: true }), 'builder-preprocess-stop');
    this.actionService.listen('preprocess-trigger', () => ({ success: true }), 'builder-preprocess-trigger');
  }

  destroy(): void {
    this.actionService.unlisten('builder-compile-begin');
    this.actionService.unlisten('builder-compile-cancel');
    this.actionService.unlisten('builder-compile-reset');
    this.actionService.unlisten('builder-preprocess-stop');
    this.actionService.unlisten('builder-preprocess-trigger');
    this.clearProgressTimer();
    this.initialized = false;
  }

  triggerPreprocess(_reason = 'manual'): void {}

  async stopPreprocess(): Promise<void> {}

  isPreprocessing(): boolean {
    return false;
  }

  async build(): Promise<ActionState> {
    if ((window as any).cycoreVideoConversions?.size) throw new Error('视频正在转换，请完成后再编译');
    if (this.buildInProgress) {
      const text = this.cancelled ? '上一次编译正在终止' : '编译正在进行中';
      this.message.warning(`${text}，请稍后再试`);
      return Promise.reject({ state: 'warn', text });
    }
    if (!this.workflowService.startBuild()) {
      const state = this.workflowService.currentState;
      const text = state === ProcessState.BUILDING
        ? '编译正在进行中'
        : state === ProcessState.UPLOADING
          ? '上传正在进行中'
          : state === ProcessState.INSTALLING
            ? '依赖安装中'
            : '系统繁忙';
      this.message.warning(`${text}，请稍后再试`);
      return Promise.reject({ state: 'warn', text });
    }

    this.cancelled = false;
    this.passed = false;
    this.buildInProgress = true;

    try {
      await this.blocklyProjectService.saveCurrentProject(false);
      if (this.cancelled) {
        throw { state: 'warn', text: '编译已取消' };
      }
      this.startProgress();
      const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
      const invalidVideo = code.match(/^\s*#error CYCORE_VIDEO_INVALID (.+)$/m);
      if (invalidVideo) {
        let detail = invalidVideo[1];
        try { detail = JSON.parse(detail); } catch { /* Keep readable compiler message. */ }
        throw new Error('视频尚未准备好：' + detail);
      }
      this.lastCode = code;
      const result = await this.projectService.compileServerProject(code);
      if (this.cancelled) {
        throw { state: 'warn', text: '编译已取消' };
      }
      this.logService.update({
        detail: [result.fullStdOut, result.fullStdErr].filter(Boolean).join('\n'),
        state: result.success ? 'done' : 'error',
      });
      if (result.success && result.videoCapacity) {
        const c=result.videoCapacity;
        const mib=(n:number)=>(n/1024/1024).toFixed(2)+' MiB';
        result.text += `；固件 ${mib(c.firmwareBytes)} / 程序分区 ${mib(c.appPartitionBytes)}，文件空间 ${mib(c.fileSystemBytes)}${c.partitionChanged ? '（已自动扩容，需 USB 烧录）' : ''}`;
      }
      this.workflowService.finishBuild(result.success, result.text);
      this.noticeService.update({
        title: result.success ? '编译成功' : '编译失败',
        text: result.text,
        detail: result.fullStdErr || result.fullStdOut || result.text,
        state: result.success ? 'done' : 'error',
        progress: result.success ? 100 : undefined,
        setTimeout: result.success ? 3000 : 600000,
      });
      if (!result.success) {
        return Promise.reject({ state: 'error', text: result.text, detail: result.fullStdErr || result.fullStdOut });
      }
      this.passed = true;
      this.currentProjectPath = this.projectService.currentProjectPath;
      return { state: 'done', text: result.text };
    } catch (error: any) {
      const state = error?.state || (this.cancelled ? 'warn' : 'error');
      const text = error?.text || error?.message || (this.cancelled ? '编译已取消' : '服务端编译失败');
      if (this.workflowService.currentState === ProcessState.BUILDING) {
        this.workflowService.finishBuild(false, text);
      }
      return Promise.reject({ state, text });
    } finally {
      this.clearProgressTimer();
      this.buildInProgress = false;
    }
  }

  cancel(): void {
    if (!this.buildInProgress) return;
    if (this.cancelled) return;
    this.cancelled = true;
    this.passed = false;
    this.clearProgressTimer();
    this.workflowService.cancelCurrent('编译已取消');
    this.noticeService.update({
      title: '编译已取消',
      text: '编译已取消',
      state: 'warn',
      setTimeout: 5000,
    });
  }

  private startProgress(): void {
    let progress = 0;
    this.noticeService.update({
      title: '编译中',
      text: '服务端正在编译项目',
      state: 'doing',
      progress,
      setTimeout: 0,
      stop: () => this.cancel(),
    });
    this.progressTimer = setInterval(() => {
      progress = Math.min(95, progress + Math.floor(Math.random() * 5) + 3);
      this.noticeService.update({
        title: '编译中',
        text: `服务端正在编译项目... ${progress}%`,
        state: 'doing',
        progress,
        setTimeout: 0,
        stop: () => this.cancel(),
      });
    }, 2000);
  }

  private clearProgressTimer(): void {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
  }
}
