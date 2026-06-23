import { Injectable } from '@angular/core';
import { BlocklyService } from './blockly.service';
import { ActionService } from '../../../services/action.service';
import { ProjectService as AppProjectService } from '../../../services/project.service';


@Injectable({
  providedIn: 'root'
})
export class _ProjectService {

  currentProjectPath;
  currentPackageData;
  private savedServerJson = '';
  private initialized = false; // 防止重复初始化

  constructor(
    private blocklyService: BlocklyService,
    private actionService: ActionService,
    private appProjectService: AppProjectService
  ) { }

  init() {
    if (this.initialized) {
      console.warn('_ProjectService 已经初始化过了，跳过重复初始化');
      return;
    }
    
    this.initialized = true;

    this.actionService.listen('project-save', async (action) => {
      await this.save(action.payload.path);
    }, 'project-save-handler');
    this.actionService.listen('project-check-unsaved', (action) => {
      let result = this.hasUnsavedChanges();
      return { hasUnsavedChanges: result };
    }, 'project-check-unsaved-handler');
  }

  // 初始化历史服务（在设置 currentProjectPath 后调用）
  initHistory() {
  }

  destroy() {
    this.actionService.unlisten('project-save-handler');
    this.actionService.unlisten('project-check-unsaved-handler');
    this.initialized = false; // 重置初始化状态
  }

  close() {

  }

  markSavedSnapshot(jsonData: any) {
    this.savedServerJson = JSON.stringify(jsonData || {});
  }

  hasUnsavedChanges(): boolean {
    try {
      // 获取当前工作区的 JSON 数据
      const currentWorkspaceJson = this.blocklyService.getWorkspaceJson();
      return JSON.stringify(currentWorkspaceJson) !== this.savedServerJson;
    } catch (error) {
      console.error('检查未保存更改时出错:', error);
      // 出错时，保守地返回 true，表示可能有未保存的更改
      return true;
    }
  }

  async save(_path: string, _createHistory: boolean = true) {
    const jsonData = this.blocklyService.getWorkspaceJson();
    await this.appProjectService.saveServerBlockly(jsonData);
    this.savedServerJson = JSON.stringify(jsonData);
  }

  async saveCurrentProject(createHistory: boolean = true): Promise<void> {
    const path = this.appProjectService.currentProjectPath || this.currentProjectPath;
    this.appProjectService.stateSubject.next('saving');

    try {
      await this.save(path, createHistory);
      this.appProjectService.stateSubject.next('saved');
    } catch (error) {
      this.appProjectService.stateSubject.next('error');
      throw error;
    }
  }

}
