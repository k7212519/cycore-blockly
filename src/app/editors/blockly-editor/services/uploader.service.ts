import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ActionService } from '../../../services/action.service';
import { NoticeService } from '../../../services/notice.service';
import { ProjectService } from '../../../services/project.service';
import { SerialService } from '../../../services/serial.service';
import { ServerFlashService } from '../../../services/server-flash.service';
import { ActionState } from '../../../services/ui.service';
import { ProcessState, WorkflowService } from '../../../services/workflow.service';
import { arduinoGenerator } from '../components/blockly/generators/arduino/arduino';
import { BlocklyService } from './blockly.service';
import { _BuilderService } from './builder.service';
import { _ProjectService } from './project.service';

@Injectable()
export class _UploaderService {
  uploadInProgress = false;
  cancelled = false;

  private initialized = false;

  constructor(
    private serialService: SerialService,
    private message: NzMessageService,
    private builderService: _BuilderService,
    private noticeService: NoticeService,
    private actionService: ActionService,
    private blocklyService: BlocklyService,
    private workflowService: WorkflowService,
    private serverFlashService: ServerFlashService,
    private projectService: ProjectService,
    private blocklyProjectService: _ProjectService,
  ) {}

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.actionService.listen('upload-begin', async () => {
      try {
        return { success: true, result: await this.upload() };
      } catch (result) {
        return { success: false, result };
      }
    }, 'uploader-upload-begin');
    this.actionService.listen('upload-cancel', () => this.cancel(), 'uploader-upload-cancel');
    this.actionService.listen('flash-softdevice', () => ({
      success: false,
      result: { message: '浏览器版不支持独立烧录 SoftDevice' },
    }), 'uploader-flash-softdevice');
  }

  destroy(): void {
    this.actionService.unlisten('uploader-upload-begin');
    this.actionService.unlisten('uploader-upload-cancel');
    this.actionService.unlisten('uploader-flash-softdevice');
    this.initialized = false;
  }

  async upload(): Promise<ActionState> {
    if (this.workflowService.currentState === ProcessState.BUILDING) {
      this.message.warning('当前正在编译中，请稍后再试');
      return Promise.reject({ state: 'warn', text: '当前正在编译中，请稍后再试' });
    }

    const serialPort = this.serialService.currentPort;
    if (!serialPort) {
      this.message.warning('请先选择串口');
      return Promise.reject({ state: 'error', text: '请先选择串口' });
    }

    this.cancelled = false;
    this.uploadInProgress = true;
    await this.blocklyProjectService.saveCurrentProject(false);
    const code = arduinoGenerator.workspaceToCode(this.blocklyService.workspace);

    try {
      const needsBuild = !this.builderService.passed
        || code !== this.builderService.lastCode
        || this.projectService.currentProjectPath !== this.builderService.currentProjectPath
        || !this.projectService.lastServerCompileResult?.flashFiles?.length;
      if (needsBuild) await this.builderService.build();
      if (this.cancelled) throw { state: 'warn', text: '上传已取消' };
      if (!this.projectService.lastServerCompileResult?.flashFiles?.length) {
        throw new Error('未检测到可用构建产物');
      }
      if (!this.workflowService.startUpload()) {
        throw { state: 'warn', text: '系统繁忙，请稍后' };
      }

      this.builderService.isUploading = true;
      const result = await this.serverFlashService.flashLastCompile(serialPort);
      this.workflowService.finishUpload(true);
      return result;
    } catch (error: any) {
      const state = error?.state || 'error';
      const text = error?.text || error?.message || '上传失败';
      this.workflowService.finishUpload(false, text);
      this.noticeService.update({
        title: state === 'warn' ? '上传未完成' : '上传失败',
        text,
        detail: error?.detail || text,
        state,
        setTimeout: state === 'warn' ? 5000 : 600000,
      });
      throw { state, text };
    } finally {
      this.uploadInProgress = false;
      this.builderService.isUploading = false;
    }
  }

  cancel(): void {
    if (!this.uploadInProgress) return;
    this.cancelled = true;
    this.uploadInProgress = false;
    this.builderService.isUploading = false;
    this.serverFlashService.cancel();
    if (this.workflowService.currentState === ProcessState.BUILDING) {
      this.builderService.cancel();
    }
    this.workflowService.finishUpload(false, 'Cancelled by user');
    this.noticeService.update({
      title: '上传已取消',
      text: '上传已取消',
      state: 'warn',
      setTimeout: 5000,
    });
  }

  async flashSoftdevice(_softdeviceName: string, _serialPort: string): Promise<{ success: boolean; message: string }> {
    return { success: false, message: '浏览器版不支持独立烧录 SoftDevice' };
  }
}
