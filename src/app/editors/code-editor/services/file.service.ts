import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzTreeNodeOptions } from 'ng-zorro-antd/tree';
import { ProjectService, ServerFileMutation, ServerFileNode } from '../../../services/project.service';

interface FileNode {
  title: string;
  key: string;
  isLeaf: boolean;
  path: string;
  children?: FileNode[];
}

function joinPath(...parts: string[]): string {
  return parts.filter(part => part !== undefined && part !== null && String(part) !== '')
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '');
}

@Injectable({ providedIn: 'root' })
export class FileService {
  static readonly MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  static readonly MAX_UPLOAD_TOTAL_BYTES = 50 * 1024 * 1024;
  static readonly MAX_FOLDER_UPLOAD_BYTES = 50 * 1024 * 1024;
  static readonly MAX_FOLDER_UPLOAD_FILES = 5000;

  currentPath = '';
  private serverTreeCache = new Map<string, NzTreeNodeOptions[]>();

  constructor(
    private message: NzMessageService,
    private projectService: ProjectService,
  ) {}

  readDir(path: string, hideHidden = false): NzTreeNodeOptions[] {
    const normalizedPath = this.normalizeServerPath(path);
    const items = this.serverTreeCache.get(normalizedPath) || [];
    return hideHidden
      ? items.filter(item => !String(item.title || '').startsWith('.'))
      : items;
  }

  async loadServerTree(): Promise<void> {
    const tree = await this.projectService.getServerFileTree();
    this.serverTreeCache.clear();
    this.indexServerTree('', tree);
  }

  readFile(path: string): string {
    this.currentPath = path;
    return '';
  }

  async deleteNodes(nodes: FileNode[], onSuccess?: (deletedPaths: string[]) => void): Promise<string[]> {
    try {
      const deletedPaths = nodes
        .map(node => this.normalizeServerPath(node.path))
        .sort((left, right) => right.length - left.length);
      for (const path of deletedPaths) {
        await this.projectService.deleteServerFile(path);
      }
      await this.loadServerTree();
      onSuccess?.(deletedPaths);
      this.message.success(nodes.length > 1 ? '删除成功' : '文件删除成功');
      return deletedPaths;
    } catch (error: any) {
      this.message.error(error?.error?.message || error?.message || '删除项目文件失败');
      return [];
    }
  }

  validateFileName(name: string): { valid: boolean; error?: string } {
    const value = (name || '').trim();
    if (!value) return { valid: false, error: '名称不能为空' };
    if (value === '.' || value === '..') return { valid: false, error: '名称包含非法字符' };
    if (/[\u3400-\u9FFF\uF900-\uFAFF]/.test(value)) return { valid: false, error: '名称不能包含中文字符' };
    if (!/^[A-Za-z0-9._-]+$/.test(value)) return { valid: false, error: '名称只能包含英文、数字、点、横线和下划线' };
    return { valid: true };
  }

  async createFileInline(parentPath: string, fileName: string): Promise<{
    success: boolean;
    error?: string;
    filePath?: string;
  }> {
    const validation = this.validateFileName(fileName);
    if (!validation.valid) return { success: false, error: validation.error };
    try {
      const filePath = joinPath(this.normalizeServerPath(parentPath), fileName.trim());
      const result = await this.projectService.createServerFile(filePath, false);
      await this.loadServerTree();
      return { success: true, filePath: result.path };
    } catch (error: any) {
      return { success: false, error: error?.error?.message || error?.message || '新建项目文件失败' };
    }
  }

  async createFolderInline(parentPath: string, folderName: string): Promise<{
    success: boolean;
    error?: string;
    folderPath?: string;
  }> {
    const validation = this.validateFileName(folderName);
    if (!validation.valid) return { success: false, error: validation.error };
    try {
      const folderPath = joinPath(this.normalizeServerPath(parentPath), folderName.trim());
      const result = await this.projectService.createServerFile(folderPath, true);
      await this.loadServerTree();
      return { success: true, folderPath: result.path };
    } catch (error: any) {
      return { success: false, error: error?.error?.message || error?.message || '新建项目目录失败' };
    }
  }

  async renameNodeInline(oldPath: string, newName: string): Promise<{
    success: boolean;
    error?: string;
    newPath?: string;
  }> {
    const validation = this.validateFileName(newName);
    if (!validation.valid) return { success: false, error: validation.error };
    try {
      const result = await this.projectService.renameServerFile(this.normalizeServerPath(oldPath), newName.trim());
      await this.loadServerTree();
      return { success: true, newPath: result.path };
    } catch (error: any) {
      return { success: false, error: error?.error?.message || error?.message || '重命名项目文件失败' };
    }
  }

  getRelativePath(path: string, rootPath = ''): string {
    const normalized = this.normalizeServerPath(path);
    const root = this.normalizeServerPath(rootPath);
    return root && normalized.startsWith(`${root}/`)
      ? normalized.slice(root.length + 1)
      : normalized;
  }

  async uploadFiles(parentPath: string, files: File[], overwrite = false): Promise<ServerFileMutation[]> {
    const oversizedFile = files.find(file => file.size >= FileService.MAX_UPLOAD_BYTES);
    if (oversizedFile) {
      throw new Error(`文件 ${oversizedFile.name} 必须小于 10MB`);
    }
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize >= FileService.MAX_UPLOAD_TOTAL_BYTES) {
      throw new Error('上传文件总大小必须小于 50MB');
    }
    const results = await this.projectService.importServerFiles(
      this.normalizeServerPath(parentPath),
      files,
      [],
      false,
      overwrite
    );
    await this.loadServerTree();
    return results;
  }

  async uploadFolder(parentPath: string, files: File[], relativePaths: string[], overwrite = false): Promise<ServerFileMutation[]> {
    if (files.length > FileService.MAX_FOLDER_UPLOAD_FILES) {
      throw new Error('文件夹文件数量不能超过 5000 个');
    }
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);
    if (totalSize >= FileService.MAX_FOLDER_UPLOAD_BYTES) {
      throw new Error('文件夹大小必须小于 50MB');
    }
    const results = await this.projectService.importServerFiles(
      this.normalizeServerPath(parentPath),
      files,
      relativePaths,
      true,
      overwrite
    );
    await this.loadServerTree();
    return results;
  }

  private indexServerTree(parentPath: string, nodes: ServerFileNode[]): void {
    const items = (nodes || []).map(node => ({
      title: node.name,
      key: node.path,
      path: node.path,
      isLeaf: !node.directory,
      expanded: false,
      selectable: true,
    } as NzTreeNodeOptions));
    this.serverTreeCache.set(
      parentPath,
      items.filter(item => !item.isLeaf).concat(items.filter(item => item.isLeaf)),
    );
    for (const node of nodes || []) {
      if (node.directory) this.indexServerTree(node.path, node.children || []);
    }
  }

  normalizeServerPath(path: string): string {
    return (path || '')
      .replace(/^server-project:[^/]+\/?/, '')
      .replace(/^\/+/, '')
      .replace(/\\/g, '/');
  }
}
