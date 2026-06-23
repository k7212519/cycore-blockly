import { Injectable } from '@angular/core';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzTreeNodeOptions } from 'ng-zorro-antd/tree';
import { ProjectService, ServerFileNode } from '../../../services/project.service';

interface FileNode {
  title: string;
  key: string;
  isLeaf: boolean;
  path: string;
  children?: FileNode[];
}

@Injectable({ providedIn: 'root' })
export class FileService {
  currentPath = '';
  private serverTreeCache = new Map<string, NzTreeNodeOptions[]>();
  private clipboard: { nodes: FileNode[]; operation: 'copy' | 'cut' | null } = {
    nodes: [],
    operation: null,
  };

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

  copyToClipboard(nodes: FileNode[]): void {
    this.clipboard = { nodes: [...nodes], operation: 'copy' };
    void navigator.clipboard?.writeText(nodes.map(node => node.path).join('\n'));
  }

  cutToClipboard(nodes: FileNode[]): void {
    this.clipboard = { nodes: [...nodes], operation: 'cut' };
    this.message.info('浏览器版暂不支持移动项目文件');
  }

  async pasteFromClipboard(_targetNode: FileNode): Promise<{
    success: boolean;
    newFiles?: Array<{ name: string; isLeaf: boolean; path: string }>;
  }> {
    this.message.info('浏览器版暂不支持复制项目文件');
    return { success: false };
  }

  getClipboardStatus() {
    return {
      hasItems: this.clipboard.nodes.length > 0,
      operation: this.clipboard.operation,
      count: this.clipboard.nodes.length,
      nodes: [...this.clipboard.nodes],
    };
  }

  clearClipboard(): void {
    this.clipboard = { nodes: [], operation: null };
  }

  deleteNodes(_nodes: FileNode[], _onSuccess?: (deletedPaths: string[]) => void): void {
    this.message.info('浏览器版暂不支持删除项目文件');
  }

  validateFileName(name: string): { valid: boolean; error?: string } {
    const value = (name || '').trim();
    if (!value) return { valid: false, error: '名称不能为空' };
    if (/[\\/:*?"<>|]/.test(value)) return { valid: false, error: '名称包含非法字符' };
    return { valid: true };
  }

  createFileInline(_parentPath: string, _fileName: string): {
    success: boolean;
    error?: string;
    filePath?: string;
  } {
    return { success: false, error: '浏览器版暂不支持新建项目文件' };
  }

  createFolderInline(_parentPath: string, _folderName: string): {
    success: boolean;
    error?: string;
    folderPath?: string;
  } {
    return { success: false, error: '浏览器版暂不支持新建项目目录' };
  }

  renameNodeInline(_oldPath: string, _newName: string): {
    success: boolean;
    error?: string;
    newPath?: string;
  } {
    return { success: false, error: '浏览器版暂不支持重命名项目文件' };
  }

  copyPathToClipboard(node: FileNode, relative: boolean, rootPath = ''): void {
    const path = relative ? this.getRelativePath(node.path, rootPath) : node.path;
    void navigator.clipboard?.writeText(path);
  }

  getRelativePath(path: string, rootPath = ''): string {
    const normalized = this.normalizeServerPath(path);
    const root = this.normalizeServerPath(rootPath);
    return root && normalized.startsWith(`${root}/`)
      ? normalized.slice(root.length + 1)
      : normalized;
  }

  revealInExplorer(_node: FileNode): void {
    this.message.info('浏览器环境没有本机文件管理器');
  }

  showProperties(node: FileNode): void {
    this.message.info(`${node.title}: ${node.path}`);
  }

  openInTerminal(_node: FileNode): void {
    this.message.info('浏览器环境不提供本机终端');
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

  private normalizeServerPath(path: string): string {
    return (path || '')
      .replace(/^server-project:[^/]+\/?/, '')
      .replace(/^\/+/, '')
      .replace(/\\/g, '/');
  }
}
