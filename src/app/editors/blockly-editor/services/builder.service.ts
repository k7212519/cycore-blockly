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
    await this.blocklyProjectService.saveCurrentProject(false);
    this.startProgress();

    try {
      const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);
      this.lastCode = code;
      const result = await this.projectService.compileServerProject(code);
      this.logService.update({
        detail: [result.fullStdOut, result.fullStdErr].filter(Boolean).join('\n'),
        state: result.success ? 'done' : 'error',
      });
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
      this.workflowService.finishBuild(false, error?.message || '服务端编译失败');
      return Promise.reject({ state: 'error', text: error?.message || '服务端编译失败' });
    } finally {
      this.clearProgressTimer();
    }
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.passed = false;
    this.clearProgressTimer();
    this.workflowService.finishBuild(false, 'Cancelled by user');
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
