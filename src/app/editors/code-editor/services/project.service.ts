import { Injectable } from '@angular/core';
import { ActionService } from '../../../services/action.service';
import { OpenedFile } from '../code-editor.component';
import { ProjectService } from '../../../services/project.service';
import { NoticeService } from '../../../services/notice.service';
import { LogService } from '../../../services/log.service';
import { SerialService } from '../../../services/serial.service';
import { WorkflowService, ProcessState } from '../../../services/workflow.service';
import { ServerFlashService } from '../../../services/server-flash.service';

interface CodeEditorComponent {
  openedFiles: OpenedFile[];
  saveFile(index: number): Promise<void>;
}

@Injectable({
  providedIn: 'root'
})
export class _ProjectService {

  private codeEditorComponent: CodeEditorComponent | null = null;
  private initialized = false; // 防止重复初始化

  constructor(
    private actionService: ActionService,
    private projectService: ProjectService,
    private noticeService: NoticeService,
    private logService: LogService,
    private serialService: SerialService,
    private workflowService: WorkflowService,
    private serverFlashService: ServerFlashService
  ) { }

  init() {
    if (this.initialized) {
      console.warn('Code Editor _ProjectService 已经初始化过了，跳过重复初始化');
      return;
    }
    
    this.initialized = true;
    this.actionService.listen('saveProject', data => {
      this.save(data.payload.path);
    }, 'code-editor-save-project');
    this.actionService.listen('project-check-unsaved', (action) => {
      let result = this.hasUnsavedChanges();
      return { hasUnsavedChanges: result };
    }, 'code-editor-check-unsaved');
    this.actionService.listen('compile-begin', async () => {
      if (!this.projectService.isServerProject) {
        return { success: false, result: { state: 'error', text: '代码编辑器本地编译暂未接入' } };
      }
      return this.compileServerProject();
    }, 'code-editor-compile-begin');
    this.actionService.listen('upload-begin', async () => {
      if (!this.projectService.isServerProject) {
        return { success: false, result: { state: 'error', text: '代码编辑器本地上传暂未接入' } };
      }
      return this.uploadServerProject();
    }, 'code-editor-upload-begin');
    this.actionService.listen('upload-cancel', () => {
      this.serverFlashService.cancel();
    }, 'code-editor-upload-cancel');
  }

  destroy() {
    this.actionService.unlisten('code-editor-save-project');
    this.actionService.unlisten('code-editor-check-unsaved');
    this.actionService.unlisten('code-editor-compile-begin');
    this.actionService.unlisten('code-editor-upload-begin');
    this.actionService.unlisten('code-editor-upload-cancel');
    this.initialized = false; // 重置初始化状态
  }

  // 注册 CodeEditorComponent 实例
  registerCodeEditor(codeEditor: CodeEditorComponent) {
    this.codeEditorComponent = codeEditor;
  }

  // 注销 CodeEditorComponent 实例
  unregisterCodeEditor() {
    this.codeEditorComponent = null;
  }

  save(path: string) {
    // 保存所有打开的文件
    if (this.codeEditorComponent && this.codeEditorComponent.openedFiles) {
      this.codeEditorComponent.openedFiles.forEach((file: OpenedFile, index: number) => {
        if (file.isDirty) {
          this.codeEditorComponent!.saveFile(index);
        }
      });
    }
  }

  private async saveAllDirty(): Promise<void> {
    if (!this.codeEditorComponent?.openedFiles) {
      return;
    }
    const tasks = this.codeEditorComponent.openedFiles
      .map((file: OpenedFile, index: number) => file.isDirty ? this.codeEditorComponent!.saveFile(index) : Promise.resolve());
    await Promise.all(tasks);
  }

  private async compileServerProject() {
    if (!this.workflowService.startBuild()) {
      const state = this.workflowService.currentState;
      let msg = '系统繁忙';
      if (state === ProcessState.BUILDING) msg = '编译正在进行中';
      else if (state === ProcessState.UPLOADING) msg = '上传正在进行中';
      else if (state === ProcessState.INSTALLING) msg = '依赖安装中';
      return { success: false, result: { state: 'warn', text: msg + '，请稍后' } };
    }

    let progress = 0;
    const progressInterval = setInterval(() => {
      if (progress < 95) {
        progress += Math.floor(Math.random() * 5) + 3;
        if (progress > 95) progress = 95;
        this.noticeService.update({
          title: '编译中',
          text: `服务端正在编译项目... ${progress}%`,
          state: 'doing',
          progress: progress,
          setTimeout: 0
        });
      }
    }, 2000);

    try {
      await this.saveAllDirty();
      this.noticeService.update({
        title: '编译中',
        text: '服务端正在编译项目',
        state: 'doing',
        progress: 0,
        setTimeout: 0
      });
      const result = await this.projectService.compileServerProject();
      clearInterval(progressInterval);
      
      this.logService.update({
        detail: [result.fullStdOut, result.fullStdErr].filter(Boolean).join('\n'),
        state: result.success ? 'done' : 'error'
      });
      this.workflowService.finishBuild(result.success, result.text);
      this.noticeService.update({
        title: result.success ? '编译成功' : '编译失败',
        text: result.text,
        state: result.success ? 'done' : 'error',
        progress: result.success ? 100 : progress,
        detail: result.fullStdErr || result.fullStdOut || result.text,
        setTimeout: result.success ? 3000 : 600000
      });
      return { success: result.success, result: { state: result.success ? 'done' : 'error', text: result.text, fullStdErr: result.fullStdErr } };
    } catch (error: any) {
      clearInterval(progressInterval);
      const text = error?.message || '服务端编译失败';
      this.workflowService.finishBuild(false, text);
      this.noticeService.update({ title: '编译失败', text, detail: text, state: 'error', setTimeout: 600000 });
      return { success: false, result: { state: 'error', text } };
    }
  }

  private async uploadServerProject() {
    const serialPort = this.serialService.currentPort;
    if (!serialPort) {
      return { success: false, result: { state: 'error', text: '请先选择串口' } };
    }

    const hasDirtyFiles = this.hasUnsavedChanges();
    if (hasDirtyFiles || !this.projectService.lastServerCompileResult?.flashFiles?.length) {
      const build = await this.compileServerProject();
      if (build.success === false) {
        return build;
      }
    }

    let uploadStarted = false;
    if (!this.workflowService.startUpload()) {
      const state = this.workflowService.currentState;
      let msg = '系统繁忙';
      if (state === ProcessState.UPLOADING) msg = '上传正在进行中';
      else if (state === ProcessState.INSTALLING) msg = '依赖安装中';
      return { success: false, result: { state: 'warn', text: msg + '，请稍后' } };
    }

    try {
      uploadStarted = true;
      const result = await this.serverFlashService.flashLastCompile(serialPort);
      this.workflowService.finishUpload(true);
      return { success: true, result };
    } catch (error: any) {
      const text = error?.message || error?.text || '上传失败';
      if (uploadStarted) {
        this.workflowService.finishUpload(false, text);
      }
      this.noticeService.update({ title: '上传失败', text, detail: text, state: 'error', setTimeout: 600000 });
      return { success: false, result: { state: error?.state || 'error', text } };
    }
  }

  hasUnsavedChanges(): boolean {
    // 检查 CodeEditorComponent 是否有未保存的文件
    if (this.codeEditorComponent && this.codeEditorComponent.openedFiles) {
      return this.codeEditorComponent.openedFiles.some((file: OpenedFile) => file.isDirty);
    }
    return false;
  }
}
