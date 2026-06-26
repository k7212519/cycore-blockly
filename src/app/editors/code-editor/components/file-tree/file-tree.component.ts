import { Component, EventEmitter, Input, Output, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { CollectionViewer, DataSource, SelectionChange } from '@angular/cdk/collections';
import { FlatTreeControl } from '@angular/cdk/tree';
import { SelectionModel } from '@angular/cdk/collections';
import { NzTreeViewModule } from 'ng-zorro-antd/tree-view';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { HttpErrorResponse } from '@angular/common/http';
import { FileService } from '../../services/file.service';
import { CommonModule } from '@angular/common';
import { BehaviorSubject, Observable, merge } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { MenuComponent } from '../../../../components/menu/menu.component';
import {
  FILE_RIGHTCLICK_MENU,
  FOLDER_RIGHTCLICK_MENU,
  ROOT_RIGHTCLICK_MENU,
  MULTI_SELECT_MENU
} from './menu.config';
import { IMenuItem } from '../../../../configs/menu.config';

// 文件节点接口定义
interface FileNode {
  title: string;
  key: string;
  isLeaf: boolean;
  path: string;
  children?: FileNode[];
}

function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
}

function dirname(path: string): string {
  const normalized = (path || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '';
}

function basename(path: string): string {
  return (path || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || '';
}

// 原始文件节点接口
interface FileNodeOrig {
  title: string;
  key: string;
  isLeaf: boolean;
  path: string;
  children?: FileNodeOrig[];
}

// 扁平化的文件节点接口
interface FlatFileNode extends FileNode {
  expandable: boolean;
  level: number;
  loading?: boolean;
}

// 内联编辑状态
interface InlineEditState {
  isEditing: boolean;
  nodeKey: string;
  editType: 'rename' | 'newFile' | 'newFolder';
  originalValue?: string;
  parentPath?: string;
}

// 动态数据源类
class DynamicFileDataSource implements DataSource<FlatFileNode> {
  private flattenedData: BehaviorSubject<FlatFileNode[]>;
  private childrenLoadedSet = new Set<FlatFileNode>();
  private expandedPaths = new Set<string>(); // 保存展开的节点路径

  constructor(
    private treeControl: FlatTreeControl<FlatFileNode>,
    private fileService: FileService,
    initData: FlatFileNode[],
    private hideHidden = false
  ) {
    this.flattenedData = new BehaviorSubject<FlatFileNode[]>(initData);
    treeControl.dataNodes = initData;
  }

  connect(collectionViewer: CollectionViewer): Observable<FlatFileNode[]> {
    const changes = [
      collectionViewer.viewChange,
      this.treeControl.expansionModel.changed.pipe(tap(change => this.handleExpansionChange(change))),
      this.flattenedData.asObservable()
    ];
    return merge(...changes).pipe(map(() => this.expandFlattenedNodes(this.flattenedData.getValue())));
  }

  expandFlattenedNodes(nodes: FlatFileNode[]): FlatFileNode[] {
    const treeControl = this.treeControl;
    const results: FlatFileNode[] = [];
    const currentExpand: boolean[] = [];
    currentExpand[0] = true;

    nodes.forEach(node => {
      let expand = true;
      for (let i = 0; i <= treeControl.getLevel(node); i++) {
        expand = expand && currentExpand[i];
      }
      if (expand) {
        results.push(node);
      }
      if (treeControl.isExpandable(node)) {
        currentExpand[treeControl.getLevel(node) + 1] = treeControl.isExpanded(node);
      }
    });
    return results;
  }

  handleExpansionChange(change: SelectionChange<FlatFileNode>): void {
    if (change.added) {
      change.added.forEach(node => this.loadChildren(node));
    }
  }

  loadChildren(node: FlatFileNode): void {
    if (this.childrenLoadedSet.has(node)) {
      return;
    }
    node.loading = true;

    // 使用 fileService 加载子文件夹内容
    const children = this.fileService.readDir(node.path, this.hideHidden);
    const flatChildren: FlatFileNode[] = children.map(child => ({
      expandable: !child.isLeaf,
      title: child.title,
      level: node.level + 1,
      key: child.key,
      isLeaf: child.isLeaf,
      path: child['path']
    }));

    node.loading = false;
    const flattenedData = this.flattenedData.getValue();
    const index = flattenedData.indexOf(node);
    if (index !== -1) {
      flattenedData.splice(index + 1, 0, ...flatChildren);
      this.childrenLoadedSet.add(node);
    }
    this.flattenedData.next(flattenedData);
  }

  disconnect(): void {
    this.flattenedData.complete();
  }

  // 更新根数据
  setRootData(data: FlatFileNode[]): void {
    this.childrenLoadedSet.clear();
    this.flattenedData.next(data);
    this.treeControl.dataNodes = data;
  }

  // 获取当前数据
  getCurrentData(): FlatFileNode[] {
    return this.flattenedData.getValue();
  }

  setHideHidden(hideHidden: boolean): void {
    this.hideHidden = hideHidden;
  }

  // 保存当前展开状态
  saveExpandedState(): void {
    this.expandedPaths.clear();
    const expandedNodes = this.treeControl.expansionModel.selected;
    expandedNodes.forEach(node => {
      this.expandedPaths.add(node.path);
    });
  }

  // 恢复展开状态
  restoreExpandedState(): void {
    const allNodes = this.flattenedData.getValue();
    setTimeout(() => {
      allNodes.forEach(node => {
        if (this.expandedPaths.has(node.path) && node.expandable) {
          this.treeControl.expand(node);
        }
      });
    }, 0);
  }

  // 增量更新节点
  updateNode(path: string, updateFn: (node: FlatFileNode) => void): void {
    const data = this.flattenedData.getValue();
    const node = data.find(n => n.path === path);
    if (node) {
      updateFn(node);
      this.flattenedData.next([...data]);
    }
  }

  // 添加新节点
  addNode(parentPath: string, newNode: FlatFileNode): void {
    const data = this.flattenedData.getValue();
    const parentIndex = data.findIndex(n => n.path === parentPath);

    if (parentIndex !== -1) {
      // 找到插入位置（在同级节点的最后）
      let insertIndex = parentIndex + 1;
      const parentLevel = data[parentIndex].level;

      // 找到同级节点的最后位置
      while (insertIndex < data.length && data[insertIndex].level > parentLevel) {
        insertIndex++;
      }

      data.splice(insertIndex, 0, newNode);
      this.flattenedData.next([...data]);
    }
  }

  // 删除节点（包括子节点）
  removeNode(nodePath: string): void {
    const data = this.flattenedData.getValue();
    const nodeIndex = data.findIndex(n => n.path === nodePath);

    console.log('DynamicFileDataSource.removeNode called for:', nodePath);
    console.log('Node found at index:', nodeIndex);

    if (nodeIndex !== -1) {
      const node = data[nodeIndex];
      const nodesToRemove = [nodeIndex];

      console.log('Removing node:', node.title, 'expandable:', node.expandable);

      // 如果是文件夹，也要删除所有子节点
      if (node.expandable) {
        for (let i = nodeIndex + 1; i < data.length; i++) {
          if (data[i].level > node.level) {
            nodesToRemove.push(i);
            console.log('Also removing child node:', data[i].title);
          } else {
            break;
          }
        }
      }

      console.log('Total nodes to remove:', nodesToRemove.length);

      // 从后往前删除，避免索引问题
      nodesToRemove.reverse().forEach(index => {
        const removedNode = data[index];
        console.log('Removing node at index', index, ':', removedNode.title);
        data.splice(index, 1);
      });

      console.log('Updating flattenedData with new array, length:', data.length);
      this.flattenedData.next([...data]);

      // 更新树控件的数据节点
      this.treeControl.dataNodes = [...data];

      // 清除相关的展开状态
      this.expandedPaths.delete(nodePath);
      this.childrenLoadedSet.forEach(loadedNode => {
        if (loadedNode.path === nodePath) {
          this.childrenLoadedSet.delete(loadedNode);
        }
      });

      console.log('Node removal completed for:', nodePath);
    } else {
      console.warn('Node not found for removal:', nodePath);
    }
  }

  // 智能刷新指定路径的内容
  refreshPath(path: string): void {
    const data = this.flattenedData.getValue();
    const nodeIndex = data.findIndex(n => n.path === path);

    if (nodeIndex !== -1) {
      const node = data[nodeIndex];
      if (node.expandable) {
        // 获取新的文件列表
        const children = this.fileService.readDir(path, this.hideHidden);
        const flatChildren: FlatFileNode[] = children.map(child => ({
          expandable: !child.isLeaf,
          title: child.title,
          level: node.level + 1,
          key: child.key,
          isLeaf: child.isLeaf,
          path: child['path']
        }));

        // 删除旧的子节点
        let deleteCount = 0;
        for (let i = nodeIndex + 1; i < data.length; i++) {
          if (data[i].level > node.level) {
            deleteCount++;
          } else {
            break;
          }
        }

        // 用新的子节点替换
        data.splice(nodeIndex + 1, deleteCount, ...flatChildren);
        this.flattenedData.next([...data]);

        // 标记子节点已加载
        this.childrenLoadedSet.add(node);
      }
    }
    // 注意：如果节点不在当前数据中，调用者应该处理刷新逻辑
  }
}

@Component({
  selector: 'app-file-tree',
  imports: [
    NzTreeViewModule,
    CommonModule,
    MenuComponent
  ],
  templateUrl: './file-tree.component.html',
  styleUrl: './file-tree.component.scss'
})
export class FileTreeComponent implements OnInit, OnChanges {
  @Input() rootPath: string;
  @Input() selectedFile;
  @Input() hideHidden = false;
  @Output() selectedFileChange = new EventEmitter();
  @Output() filesDeleted = new EventEmitter<string[]>();

  isLoading = false;

  options = {
    autoHide: true,
    clickOnTrack: true,
    scrollbarMinSize: 50,
  };

  // 选择模型 - 用于跟踪选中的节点
  nodeSelection = new SelectionModel<FlatFileNode>(true); // 允许多选

  // 最后一次点击的节点，用于 Shift 范围选择
  private lastClickedNode: FlatFileNode | null = null;

  // 树控件 - 使用 FlatTreeControl
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - 已知的弃用警告，等待 ng-zorro-antd 更新
  treeControl = new FlatTreeControl<FlatFileNode>(
    node => node.level,
    node => node.expandable
  );

  // 动态数据源
  dataSource: DynamicFileDataSource;

  // 显示右键菜单
  showRightClickMenu = false;
  rightClickMenuPosition = { x: null, y: null };
  configList: IMenuItem[] = [];
  currentSelectedNode: FlatFileNode | null = null;

  // 内联编辑状态
  inlineEditState: InlineEditState = {
    isEditing: false,
    nodeKey: '',
    editType: 'rename'
  };
  private inlineEditSubmitting = false;
  private uploadTargetNode: FlatFileNode | null = null;
  uploadDialogVisible = false;
  uploadMode: 'file' | 'folder' = 'file';
  uploadDragActive = false;
  uploadSubmitting = false;
  pendingUploadFiles: File[] = [];
  pendingUploadRelativePaths: string[] = [];

  constructor(
    private fileService: FileService,
    private message: NzMessageService,
    private modal: NzModalService
  ) {
    // 初始化时创建空的数据源
    this.dataSource = new DynamicFileDataSource(this.treeControl, this.fileService, []);
  }

  ngOnInit() {
    this.loadRootPath();
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['hideHidden']) {
      this.dataSource.setHideHidden(this.hideHidden);
    }
    if (changes['rootPath'] && !changes['rootPath'].firstChange && this.rootPath) {
      this.loadRootPath();
    } else if (changes['hideHidden'] && !changes['hideHidden'].firstChange && this.rootPath) {
      this.loadRootPath();
    }
  }

  ngAfterViewInit() {
    setTimeout(() => {
      const files = this.dataSource.getCurrentData();
      const inoFile = files.find(f => f.isLeaf && f.title.endsWith('.ino'));
      if (inoFile) {
        this.openFile(inoFile);
      }
    }, 0);
  }

  async loadRootPath(path = this.rootPath): Promise<void> {
    // 保存当前展开状态
    if (this.dataSource) {
      this.dataSource.saveExpandedState();
    }

    if (typeof path === 'string' && path.startsWith('server-project:')) {
      this.isLoading = true;
      await this.fileService.loadServerTree();
      this.isLoading = false;
    }

    const files = this.fileService.readDir(path, this.hideHidden);
    console.log('Loaded root path files:', files);

    // 转换为扁平节点格式
    const flatFiles: FlatFileNode[] = files.map(file => ({
      expandable: !file.isLeaf,
      title: file.title,
      level: 0,
      key: file.key,
      isLeaf: file.isLeaf,
      path: file['path']
    }));

    this.dataSource.setRootData(flatFiles);

    // 恢复展开状态
    this.dataSource.restoreExpandedState();
  }

  // 判断节点是否有子节点
  hasChild = (_: number, node: FlatFileNode): boolean => node.expandable;

  // 当节点被点击时
  nodeClick(node: FlatFileNode, event?: MouseEvent): void {
    // 如果正在编辑，不处理点击事件
    if (this.isNodeEditing(node)) {
      return;
    }

    // 处理多选逻辑
    this.handleNodeSelection(node, event);

    // 如果是文件且只选择了一个，则打开文件
    if (node.isLeaf && this.nodeSelection.selected.length === 1 && this.nodeSelection.isSelected(node)) {
      this.openFile(node);
    } else if (!node.isLeaf && this.nodeSelection.selected.length === 1 && this.nodeSelection.isSelected(node)) {
      // 如果是文件夹且只选择了一个，则展开/收起
      this.openFolder(node);
    }
  }

  // 处理节点选择逻辑
  private handleNodeSelection(node: FlatFileNode, event?: MouseEvent): void {
    const isCtrlPressed = event?.ctrlKey || event?.metaKey; // Mac 用 metaKey
    const isShiftPressed = event?.shiftKey;

    if (isShiftPressed && this.lastClickedNode) {
      // Shift + 点击：范围选择
      this.selectRange(this.lastClickedNode, node);
    } else if (isCtrlPressed) {
      // Ctrl + 点击：切换选择状态
      this.nodeSelection.toggle(node);
      this.lastClickedNode = node;
    } else {
      // 普通点击：清除其他选择，只选择当前节点
      this.nodeSelection.clear();
      this.nodeSelection.select(node);
      this.lastClickedNode = node;
    }
  }

  // 范围选择：选择两个节点之间的所有节点
  private selectRange(startNode: FlatFileNode, endNode: FlatFileNode): void {
    const allNodes = this.dataSource.getCurrentData();
    const startIndex = allNodes.indexOf(startNode);
    const endIndex = allNodes.indexOf(endNode);

    if (startIndex === -1 || endIndex === -1) {
      return;
    }

    // 确保 start <= end
    const minIndex = Math.min(startIndex, endIndex);
    const maxIndex = Math.max(startIndex, endIndex);

    // 清除当前选择
    this.nodeSelection.clear();

    // 选择范围内的所有节点
    for (let i = minIndex; i <= maxIndex; i++) {
      this.nodeSelection.select(allNodes[i]);
    }
  }

  menuList;
  onRightClick(event: MouseEvent, node: FlatFileNode = null) {
    event.preventDefault(); // 阻止浏览器默认右键菜单

    // 如果是在文件或文件夹节点上右键，阻止事件冒泡
    if (node) {
      event.stopPropagation();
    }

    // 处理右键点击时的选择逻辑
    if (node) {
      // 如果右键点击的节点没有被选中，则清除其他选择并选择当前节点
      if (!this.nodeSelection.isSelected(node)) {
        this.nodeSelection.clear();
        this.nodeSelection.select(node);
        this.lastClickedNode = node;
      }
    }

    const selectedNodes = this.nodeSelection.selected;
    const selectedCount = selectedNodes.length;

    if (!node) {
      // 右键点击空白区域
      this.currentSelectedNode = this.createRootNode();
      this.menuList = ROOT_RIGHTCLICK_MENU;
    } else if (selectedCount > 1) {
      // 多选状态
      this.currentSelectedNode = node;
      this.menuList = MULTI_SELECT_MENU;
    } else if (node.isLeaf) {
      // 单个文件
      this.currentSelectedNode = node;
      this.menuList = FILE_RIGHTCLICK_MENU;
    } else {
      // 单个文件夹
      this.currentSelectedNode = node;
      this.menuList = FOLDER_RIGHTCLICK_MENU;
    }

    // 获取当前鼠标点击位置
    this.rightClickMenuPosition.x = event.clientX;
    this.rightClickMenuPosition.y = event.clientY;

    this.showRightClickMenu = true;
  }

  onMenuItemClick(menuItem: IMenuItem) {
    console.log('Menu item clicked:', menuItem, 'Node:', this.currentSelectedNode);
    // 隐藏菜单
    this.showRightClickMenu = false;
    // 处理菜单项点击事件
    this.handleMenuAction(menuItem);
  }

  // 创建根节点
  private createRootNode(): FlatFileNode {
    return {
      expandable: true,
      title: 'root',
      level: 0,
      key: 'root',
      isLeaf: false,
      path: this.rootPath
    };
  }

  private handleMenuAction(menuItem: IMenuItem) {
    const selectedNodes = this.nodeSelection.selected;
    // 如果currentSelectedNode为null，则默认操作根目录
    const currentNode = this.currentSelectedNode || this.createRootNode();

    switch (menuItem.action) {
      case 'file-rename':
      case 'folder-rename':
        this.renameNode(currentNode);
        break;

      case 'file-delete':
      case 'folder-delete':
      case 'multi-delete':
        void this.deleteNodes(selectedNodes.length > 1 ? selectedNodes : [currentNode]);
        break;

      case 'folder-new-file':
        this.createNewFile(currentNode);
        break;

      case 'folder-new-folder':
        this.createNewFolder(currentNode);
        break;

      case 'folder-upload-files':
        this.openUploadDialog(currentNode);
        break;

      default:
        console.log('Unhandled menu action:', menuItem.action);
    }
  }

  private renameNode(node: FlatFileNode) {
    // 使用内联编辑
    this.startInlineEdit(node, 'rename');
  }

  private async deleteNodes(nodes: FlatFileNode[]): Promise<void> {
    console.log('Starting delete operation for nodes:', nodes.map(n => n.path));

    const deletedPaths = await this.fileService.deleteNodes(nodes);
    if (deletedPaths.length === 0) {
      return;
    }

    try {
      console.log('Delete callback received for paths:', deletedPaths);

      // 发出文件删除事件，通知父组件
      this.filesDeleted.emit(deletedPaths);

      // 清除已删除节点的选择状态
      const currentSelected = this.nodeSelection.selected.filter(
        node => !deletedPaths.includes(this.fileService.normalizeServerPath(node.path))
      );
      this.nodeSelection.clear();
      currentSelected.forEach(node => {
        this.nodeSelection.select(node);
      });

      await this.loadRootPath();
      console.log('Delete operation completed, file tree reloaded');
    } catch (error) {
      console.error('Error updating UI after delete:', error);
      // 如果刷新失败，强制刷新整个树
      this.refresh();
    }
  }

  private createNewFile(parentNode: FlatFileNode) {
    // 确定实际的父路径
    let parentPath = parentNode.path;
    if (parentNode.isLeaf) {
      parentPath = dirname(parentPath);
    }

    // 创建临时节点用于内联编辑，使用时间戳确保唯一性
    const tempKey = `__new_file_temp_${Date.now()}__`;
    const tempPath = joinPath(parentPath, tempKey);
    const tempNode: FlatFileNode = {
      expandable: false,
      title: '',
      level: parentNode.isLeaf ? parentNode.level : parentNode.level + 1,
      key: tempPath,
      isLeaf: true,
      path: tempPath
    };

    // 添加临时节点到适当位置
    this.addFileNodeDirect(parentPath, tempKey, true);

    // 开始内联编辑
    this.startInlineEdit(tempNode, 'newFile', parentPath);
  }

  private createNewFolder(parentNode: FlatFileNode) {
    // 确定实际的父路径
    let parentPath = parentNode.path;
    if (parentNode.isLeaf) {
      parentPath = dirname(parentPath);
    }

    // 创建临时节点用于内联编辑，使用时间戳确保唯一性
    const tempKey = `__new_folder_temp_${Date.now()}__`;
    const tempPath = joinPath(parentPath, tempKey);
    const tempNode: FlatFileNode = {
      expandable: true,
      title: '',
      level: parentNode.isLeaf ? parentNode.level : parentNode.level + 1,
      key: tempPath,
      isLeaf: false,
      path: tempPath
    };

    // 添加临时节点到适当位置
    this.addFileNodeDirect(parentPath, tempKey, false);

    // 开始内联编辑
    this.startInlineEdit(tempNode, 'newFolder', parentPath);
  }

  private openUploadDialog(targetNode: FlatFileNode): void {
    this.uploadTargetNode = targetNode;
    this.uploadDialogVisible = true;
    this.uploadDragActive = false;
    this.uploadSubmitting = false;
    this.uploadMode = 'file';
    this.clearPendingUpload();
  }

  closeUploadDialog(): void {
    if (this.uploadSubmitting) return;
    this.uploadDialogVisible = false;
    this.uploadDragActive = false;
    this.clearPendingUpload();
  }

  setUploadMode(mode: 'file' | 'folder'): void {
    if (this.uploadMode === mode) return;
    this.uploadMode = mode;
    this.clearPendingUpload();
  }

  onDialogFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.setPendingUpload(Array.from(input.files || []), [], 'file', true);
    input.value = '';
  }

  onDialogFolderInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    const relativePaths = files.map(file => (file as any).webkitRelativePath || file.name);
    this.setPendingUpload(files, relativePaths, 'folder');
    input.value = '';
  }

  onUploadDragOver(event: DragEvent): void {
    event.preventDefault();
    this.uploadDragActive = true;
  }

  onUploadDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.uploadDragActive = false;
  }

  async onUploadDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.uploadDragActive = false;
    const items = Array.from(event.dataTransfer?.items || []);
    if (items.length > 0 && items.some(item => !!(item as any).webkitGetAsEntry)) {
      const dropped = await this.readDroppedEntries(items);
      if (dropped.files.length > 0) {
        const hasDirectory = dropped.relativePaths.some(path => path.includes('/'));
        this.setPendingUpload(dropped.files, dropped.relativePaths, hasDirectory ? 'folder' : 'file', !hasDirectory);
        return;
      }
    }
    const files = Array.from(event.dataTransfer?.files || []);
    this.setPendingUpload(files, files.map(file => file.name), 'file', true);
  }

  async confirmUpload(): Promise<void> {
    if (!this.uploadTargetNode || this.pendingUploadFiles.length === 0) {
      this.message.error('请选择要上传的文件或文件夹');
      return;
    }
    if (!this.validatePendingUpload()) {
      return;
    }

    const targetPath = this.uploadTargetNode.isLeaf
      ? dirname(this.uploadTargetNode.path)
      : this.uploadTargetNode.path;
    this.uploadSubmitting = true;
    try {
      if (this.uploadMode === 'folder') {
        await this.fileService.uploadFolder(targetPath, this.pendingUploadFiles, this.pendingUploadRelativePaths, false);
        this.message.success(`已上传 ${this.pendingUploadFiles.length} 个文件`);
      } else {
        await this.fileService.uploadFiles(targetPath, this.pendingUploadFiles, false);
        this.message.success(`已上传 ${this.pendingUploadFiles.length} 个文件`);
      }
      this.uploadDialogVisible = false;
      this.clearPendingUpload();
      await this.loadRootPath();
    } catch (error) {
      if (this.isConflictError(error)) {
        const overwrite = await this.confirmOverwrite(this.uploadMode === 'folder'
          ? '所选文件夹中的同名文件'
          : '所选文件中的同名文件');
        if (overwrite) {
          await this.confirmUploadOverwrite(targetPath);
        }
      } else {
        const uploadError = error as any;
        this.message.error(uploadError?.error?.message || uploadError?.message || '上传失败');
      }
    } finally {
      this.uploadSubmitting = false;
    }
  }

  private async confirmUploadOverwrite(targetPath: string): Promise<void> {
    try {
      if (this.uploadMode === 'folder') {
        await this.fileService.uploadFolder(targetPath, this.pendingUploadFiles, this.pendingUploadRelativePaths, true);
        this.message.success(`已上传 ${this.pendingUploadFiles.length} 个文件`);
      } else {
        await this.fileService.uploadFiles(targetPath, this.pendingUploadFiles, true);
        this.message.success(`已上传 ${this.pendingUploadFiles.length} 个文件`);
      }
      this.uploadDialogVisible = false;
      this.clearPendingUpload();
      await this.loadRootPath();
    } catch (error: any) {
      this.message.error(error?.error?.message || error?.message || '上传失败');
    }
  }

  private setPendingUpload(files: File[], relativePaths: string[], mode: 'file' | 'folder', append = false): void {
    if (files.length === 0) return;
    const filtered = this.filterHiddenUploadEntries(files, relativePaths, mode);
    if (filtered.files.length === 0) {
      this.message.warning(filtered.invalidCount > 0 ? '所选文件名不符合规则，没有可上传的文件' : '隐藏文件已过滤，没有可上传的文件');
      return;
    }
    if (filtered.hiddenCount > 0) {
      this.message.info(`已过滤 ${filtered.hiddenCount} 个隐藏文件或目录`);
    }
    if (filtered.invalidCount > 0) {
      this.message.warning(filtered.invalidMessage || `已过滤 ${filtered.invalidCount} 个文件名不符合规则的文件`);
    }

    const previousFiles = this.pendingUploadFiles;
    const previousPaths = this.pendingUploadRelativePaths;
    const previousMode = this.uploadMode;
    this.uploadMode = mode;
    this.pendingUploadFiles = mode === 'file' && append && previousMode === 'file'
      ? [...previousFiles, ...filtered.files]
      : filtered.files;
    this.pendingUploadRelativePaths = mode === 'file'
      ? this.pendingUploadFiles.map(file => file.name)
      : this.pendingUploadFiles.map((file, index) => filtered.relativePaths[index] || file.name);
    if (!this.validatePendingUpload()) {
      this.pendingUploadFiles = previousFiles;
      this.pendingUploadRelativePaths = previousPaths;
      this.uploadMode = previousMode;
    }
  }

  private filterHiddenUploadEntries(files: File[], relativePaths: string[], mode: 'file' | 'folder'): {
    files: File[];
    relativePaths: string[];
    hiddenCount: number;
    invalidCount: number;
    invalidMessage?: string;
  } {
    const visibleFiles: File[] = [];
    const visiblePaths: string[] = [];
    let hiddenCount = 0;
    let invalidCount = 0;
    let invalidMessage = '';

    files.forEach((file, index) => {
      const uploadPath = mode === 'folder' ? (relativePaths[index] || file.name) : file.name;
      if (this.isHiddenUploadPath(uploadPath)) {
        hiddenCount++;
        return;
      }
      const validationError = this.getUploadPathValidationError(uploadPath);
      if (validationError) {
        invalidCount++;
        invalidMessage ||= validationError;
        return;
      }
      visibleFiles.push(file);
      visiblePaths.push(uploadPath);
    });

    return {
      files: visibleFiles,
      relativePaths: visiblePaths,
      hiddenCount,
      invalidCount,
      invalidMessage
    };
  }

  private isHiddenUploadPath(path: string): boolean {
    return (path || '')
      .replace(/\\/g, '/')
      .split('/')
      .some(segment => segment.startsWith('.'));
  }

  private getUploadPathValidationError(path: string): string {
    const segments = (path || '').replace(/\\/g, '/').split('/').filter(Boolean);
    for (const segment of segments) {
      if (/[\u3400-\u9FFF\uF900-\uFAFF]/.test(segment)) {
        return `文件名不能包含中文字符：${segment}`;
      }
      if (segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment)) {
        return `文件名只能包含英文、数字、点、横线和下划线：${segment}`;
      }
    }
    return '';
  }

  private validatePendingUpload(): boolean {
    if (this.uploadMode === 'file') {
      const oversizedFile = this.pendingUploadFiles.find(file => file.size >= FileService.MAX_UPLOAD_BYTES);
      if (oversizedFile) {
        this.message.error(`文件 ${oversizedFile.name} 必须小于 10MB`);
        return false;
      }
      if (this.pendingUploadTotalSize >= FileService.MAX_UPLOAD_TOTAL_BYTES) {
        this.message.error('上传文件总大小必须小于 50MB');
        return false;
      }
      const fileNames = new Set(this.pendingUploadFiles.map(file => file.name));
      if (fileNames.size !== this.pendingUploadFiles.length) {
        this.message.error('上传文件存在重名，请去掉重复文件');
        return false;
      }
      return true;
    }

    if (this.pendingUploadFiles.length > FileService.MAX_FOLDER_UPLOAD_FILES) {
      this.message.error('文件夹文件数量不能超过 5000 个');
      return false;
    }
    if (this.pendingUploadTotalSize >= FileService.MAX_FOLDER_UPLOAD_BYTES) {
      this.message.error('文件夹大小必须小于 50MB');
      return false;
    }
    return true;
  }

  private clearPendingUpload(): void {
    this.pendingUploadFiles = [];
    this.pendingUploadRelativePaths = [];
  }

  get pendingUploadTotalSize(): number {
    return this.pendingUploadFiles.reduce((sum, file) => sum + file.size, 0);
  }

  get uploadTargetLabel(): string {
    if (!this.uploadTargetNode) return '';
    return this.uploadTargetNode.isLeaf ? dirname(this.uploadTargetNode.path) || '项目根目录' : this.uploadTargetNode.path || '项目根目录';
  }

  private async readDroppedEntries(items: DataTransferItem[]): Promise<{ files: File[]; relativePaths: string[] }> {
    const results: Array<{ file: File; path: string }> = [];
    for (const item of items) {
      const entry = (item as any).webkitGetAsEntry?.();
      if (entry) {
        results.push(...await this.readDroppedEntry(entry, ''));
      }
    }
    return {
      files: results.map(result => result.file),
      relativePaths: results.map(result => result.path)
    };
  }

  private async readDroppedEntry(entry: any, parentPath: string): Promise<Array<{ file: File; path: string }>> {
    if (entry?.name && this.isHiddenUploadPath(entry.name)) {
      return [];
    }
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
      return [{ file, path: joinPath(parentPath, file.name) }];
    }
    if (!entry.isDirectory) return [];

    const directoryPath = joinPath(parentPath, entry.name);
    const reader = entry.createReader();
    const children: any[] = [];
    while (true) {
      const batch = await new Promise<any[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) break;
      children.push(...batch);
    }
    const results: Array<{ file: File; path: string }> = [];
    for (const child of children) {
      results.push(...await this.readDroppedEntry(child, directoryPath));
    }
    return results;
  }

  private isConflictError(error: unknown): boolean {
    return error instanceof HttpErrorResponse && error.status === 409;
  }

  private confirmOverwrite(fileName: string): Promise<boolean> {
    return new Promise(resolve => {
      this.modal.confirm({
        nzTitle: '确认覆盖文件',
        nzContent: `目标目录已存在「${fileName}」，是否覆盖？`,
        nzOkText: '覆盖',
        nzOkDanger: true,
        nzCancelText: '取消',
        nzOnOk: () => resolve(true),
        nzOnCancel: () => resolve(false)
      });
    });
  }

  // 获取当前数据
  getCurrentData(): FlatFileNode[] {
    return this.dataSource.getCurrentData();
  }

  openFolder(folder: FlatFileNode) {
    // 如果是文件夹，展开或收起
    if (this.treeControl.isExpanded(folder)) {
      this.treeControl.collapse(folder);
    } else {
      this.treeControl.expand(folder);
      // 动态数据源会自动处理子文件夹的加载
    }
  }

  openFile(file: FlatFileNode) {
    this.selectedFile = file.path;
    this.selectedFileChange.emit(file);
  }

  getFileIcon(filename: string): string {
    // 根据文件扩展名返回不同的图标类
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    switch (ext) {
      case 'c': return 'fa-solid fa-c';
      case 'cpp': return 'fa-solid fa-c';
      case 'h': return 'fa-solid fa-h';
      case 'ino': return 'fa-solid fa-infinity main';
      // case 'json': return 'fa-light fa-brackets-curly'
      default: return 'fa-solid fa-file';
    }
  }

  // 检查文件列表是否为空
  isEmpty(): boolean {
    return this.dataSource.getCurrentData().length === 0;
  }

  refresh() {
    // 保存当前选择的路径
    const selectedPaths = this.nodeSelection.selected.map(node => node.path);

    // 保存展开状态，然后重新加载
    this.loadRootPath();

    // 恢复选择状态
    setTimeout(() => {
      this.restoreSelection(selectedPaths);
    }, 0);
  }

  // 获取选中节点的数量和类型信息
  getSelectionInfo(): { count: number; files: number; folders: number } {
    const selected = this.nodeSelection.selected;
    return {
      count: selected.length,
      files: selected.filter(node => node.isLeaf).length,
      folders: selected.filter(node => !node.isLeaf).length
    };
  }

  // 清除所有选择
  clearSelection(): void {
    this.nodeSelection.clear();
    this.lastClickedNode = null;
  }

  // 选择所有可见节点
  selectAll(): void {
    const allNodes = this.dataSource.getCurrentData();
    this.nodeSelection.clear();
    allNodes.forEach(node => {
      this.nodeSelection.select(node);
    });
  }

  // 反选当前选择
  invertSelection(): void {
    const allNodes = this.dataSource.getCurrentData();
    const currentSelected = [...this.nodeSelection.selected];

    this.nodeSelection.clear();
    allNodes.forEach(node => {
      if (!currentSelected.includes(node)) {
        this.nodeSelection.select(node);
      }
    });
  }

  // 恢复选择状态
  private restoreSelection(selectedPaths: string[]): void {
    this.nodeSelection.clear();
    const allNodes = this.dataSource.getCurrentData();

    selectedPaths.forEach(path => {
      const node = allNodes.find(n => n.path === path);
      if (node) {
        this.nodeSelection.select(node);
      }
    });
  }

  // 处理键盘事件
  onKeyDown(event: KeyboardEvent): void {
    const isCtrlPressed = event.ctrlKey || event.metaKey;

    switch (event.key) {
      case 'a':
      case 'A':
        if (isCtrlPressed) {
          event.preventDefault();
          this.selectAll();
        }
        break;

      case 'Escape':
        event.preventDefault();
        this.clearSelection();
        break;

      case 'Delete':
        if (this.nodeSelection.selected.length > 0) {
          event.preventDefault();
          void this.deleteNodes(this.nodeSelection.selected);
        }
        break;

      case 'F2':
        if (this.nodeSelection.selected.length === 1) {
          event.preventDefault();
          this.renameNode(this.nodeSelection.selected[0]);
        }
        break;
    }
  }

  // 处理内容区域点击事件（用于在空白区域点击时清除选择）
  onContentClick(event: MouseEvent): void {
    // 检查点击的是否是空白区域（没有点击到树节点）
    const target = event.target as HTMLElement;
    if (target.classList.contains('file-explorer-content') ||
      target.classList.contains('sscroll')) {
      // 如果没有按住 Ctrl 或 Shift，清除选择
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) {
        this.clearSelection();
      }
    }
  }

  // 智能刷新 - 只刷新指定路径的内容
  smartRefresh(targetPath?: string) {
    if (!targetPath) {
      // 如果没有指定路径，刷新根目录
      this.refresh();
      return;
    }

    // 刷新指定路径
    this.dataSource.refreshPath(targetPath);
  }

  // 增量更新 - 添加新文件/文件夹
  addFileNode(parentPath: string, newFileName: string, isLeaf: boolean) {
    const fullPath = joinPath(parentPath, newFileName);
    const parentNode = this.dataSource.getCurrentData().find(n => n.path === parentPath);

    if (parentNode) {
      const newNode: FlatFileNode = {
        expandable: !isLeaf,
        title: newFileName,
        level: parentNode.level + 1,
        key: fullPath,
        isLeaf: isLeaf,
        path: fullPath
      };

      this.dataSource.addNode(parentPath, newNode);
    }
  }

  // 直接添加文件节点（不依赖父节点存在）
  addFileNodeDirect(parentPath: string, newFileName: string, isLeaf: boolean) {
    const fullPath = joinPath(parentPath, newFileName);
    const data = this.dataSource.getCurrentData();

    // 检查文件是否已存在
    const existingNode = data.find(n => n.path === fullPath);
    if (existingNode) {
      return; // 文件已存在，不重复添加
    }

    // 寻找合适的插入位置
    let insertLevel = 0;
    let insertIndex = data.length; // 默认插入到末尾

    // 如果是根目录，直接插入到顶层
    if (parentPath === this.rootPath) {
      insertLevel = 0;
      // 按文件类型和字母顺序排序：文件夹在前，文件在后
      for (let i = 0; i < data.length; i++) {
        if (data[i].level === 0) {
          if (isLeaf && !data[i].isLeaf) {
            // 新文件，当前是文件夹，继续查找
            continue;
          } else if (!isLeaf && data[i].isLeaf) {
            // 新文件夹，当前是文件，插入这里
            insertIndex = i;
            break;
          } else if (data[i].title > newFileName) {
            // 同类型，按字母顺序
            insertIndex = i;
            break;
          }
        } else if (data[i].level < 0) {
          // 已经到了下一层，停止
          break;
        }
      }
    } else {
      // 寻找父节点
      const parentNodeIndex = data.findIndex(n => n.path === parentPath);
      if (parentNodeIndex !== -1) {
        const parentNode = data[parentNodeIndex];
        insertLevel = parentNode.level + 1;

        // 找到同级节点的末尾位置，并按照文件类型和字母顺序排序
        insertIndex = parentNodeIndex + 1;
        while (insertIndex < data.length && data[insertIndex].level > parentNode.level) {
          if (data[insertIndex].level === insertLevel) {
            if (isLeaf && !data[insertIndex].isLeaf) {
              // 新文件，当前是文件夹，继续查找
            } else if (!isLeaf && data[insertIndex].isLeaf) {
              // 新文件夹，当前是文件，插入这里
              break;
            } else if (data[insertIndex].title > newFileName) {
              // 同类型，按字母顺序
              break;
            }
          }
          insertIndex++;
        }
      } else {
        // 父节点不存在，可能需要先展开父节点
        console.warn('Parent node not found:', parentPath);
        return;
      }
    }

    const newNode: FlatFileNode = {
      expandable: !isLeaf,
      title: newFileName,
      level: insertLevel,
      key: fullPath,
      isLeaf: isLeaf,
      path: fullPath
    };

    // 直接插入到数据中
    data.splice(insertIndex, 0, newNode);
    // 使用flattenedData.next来触发更新，避免完全重置
    this.dataSource['flattenedData'].next([...data]);
  }

  // 增量更新 - 删除文件/文件夹
  removeFileNode(nodePath: string) {
    console.log('removeFileNode called for:', nodePath);
    const currentData = this.dataSource.getCurrentData();
    console.log('Current data before removal:', currentData.map(n => n.path));

    this.dataSource.removeNode(nodePath);

    const updatedData = this.dataSource.getCurrentData();
    console.log('Current data after removal:', updatedData.map(n => n.path));
  }

  // 增量更新 - 重命名文件/文件夹
  renameFileNode(oldPath: string, newPath: string) {
    this.dataSource.updateNode(oldPath, (node) => {
      node.path = newPath;
      node.key = newPath;
      node.title = basename(newPath);
    });
  }

  // ==================== 内联编辑方法 ====================

  // 开始内联编辑
  startInlineEdit(node: FlatFileNode, editType: 'rename' | 'newFile' | 'newFolder', parentPath?: string) {
    // 如果正在编辑其他节点，先取消
    if (this.inlineEditState.isEditing) {
      this.cancelInlineEdit();
    }

    this.inlineEditState = {
      isEditing: true,
      nodeKey: node.key,
      editType: editType,
      originalValue: editType === 'rename' ? node.title : '',
      parentPath: parentPath
    };

    // 延迟到下一个事件循环，确保DOM已更新
    setTimeout(() => {
      this.focusInlineInput();
    }, 0);
  }

  // 取消内联编辑
  cancelInlineEdit() {
    if (this.inlineEditState.editType !== 'rename') {
      // 如果是新建操作，需要删除临时节点
      this.removeInlineEditTempNode();
    }

    this.inlineEditState = {
      isEditing: false,
      nodeKey: '',
      editType: 'rename'
    };
  }

  // 完成内联编辑
  async finishInlineEdit(inputValue: string): Promise<void> {
    if (!this.inlineEditState.isEditing || this.inlineEditSubmitting) {
      return;
    }

    const trimmedValue = inputValue.trim();

    if (!trimmedValue) {
      this.cancelInlineEdit();
      return;
    }

    this.inlineEditSubmitting = true;
    try {
      switch (this.inlineEditState.editType) {
        case 'rename':
          await this.performRename(trimmedValue);
          break;
        case 'newFile':
          await this.performCreateFile(trimmedValue);
          break;
        case 'newFolder':
          await this.performCreateFolder(trimmedValue);
          break;
      }
    } finally {
      this.inlineEditSubmitting = false;
      this.inlineEditState = {
        isEditing: false,
        nodeKey: '',
        editType: 'rename'
      };
    }
  }

  // 检查节点是否正在编辑
  isNodeEditing(node: FlatFileNode): boolean {
    return this.inlineEditState.isEditing && this.inlineEditState.nodeKey === node.key;
  }

  // 获取编辑时显示的值
  getEditingValue(node: FlatFileNode): string {
    if (this.isNodeEditing(node)) {
      return this.inlineEditState.originalValue || '';
    }
    return node.title;
  }

  // 聚焦到输入框
  private focusInlineInput() {
    const inputElement = document.querySelector('.inline-edit-input') as HTMLInputElement;
    if (inputElement) {
      inputElement.focus();

      // 选择文本（对于重命名操作，选择不包括扩展名的部分）
      if (this.inlineEditState.editType === 'rename' && this.inlineEditState.originalValue) {
        const value = this.inlineEditState.originalValue;
        const lastDotIndex = value.lastIndexOf('.');
        if (lastDotIndex > 0) {
          inputElement.setSelectionRange(0, lastDotIndex);
        } else {
          inputElement.select();
        }
      } else {
        inputElement.select();
      }
    }
  }

  // 移除临时节点（用于取消新建操作）
  private removeInlineEditTempNode() {
    if (this.inlineEditState.nodeKey) {
      this.removeFileNode(this.inlineEditState.nodeKey);
    }
  }

  // 执行重命名
  private async performRename(newName: string): Promise<void> {
    const node = this.dataSource.getCurrentData().find(n => n.key === this.inlineEditState.nodeKey);
    if (!node) {
      return;
    }

    if (newName === this.inlineEditState.originalValue) {
      // 名称没有变化，直接结束
      return;
    }

    // 验证文件名
    const validation = this.fileService.validateFileName(newName);
    if (!validation.valid) {
      this.message.error(validation.error);
      return;
    }

    const result = await this.fileService.renameNodeInline(node.path, newName);
    if (result.success) {
      this.message.success('重命名成功');

      // 更新节点信息
      this.renameFileNode(node.path, result.newPath);

      // 更新选择状态中的节点路径
      if (this.nodeSelection.isSelected(node)) {
        node.path = result.newPath;
        node.key = result.newPath;
        node.title = newName;
      }
    } else {
      this.message.error(result.error);
    }
  }

  // 执行创建文件
  private async performCreateFile(fileName: string): Promise<void> {
    if (!this.inlineEditState.parentPath) {
      return;
    }

    const result = await this.fileService.createFileInline(this.inlineEditState.parentPath, fileName);

    if (result.success) {
      this.message.success('文件创建成功');
      // 更新临时节点为实际节点
      this.updateTempNodeToReal(fileName, result.filePath, true);
    } else {
      this.message.error(result.error);
      this.removeInlineEditTempNode();
    }
  }

  // 执行创建文件夹
  private async performCreateFolder(folderName: string): Promise<void> {
    if (!this.inlineEditState.parentPath) {
      return;
    }

    const result = await this.fileService.createFolderInline(this.inlineEditState.parentPath, folderName);

    if (result.success) {
      this.message.success('文件夹创建成功');
      // 更新临时节点为实际节点
      this.updateTempNodeToReal(folderName, result.folderPath, false);
    } else {
      this.message.error(result.error);
      this.removeInlineEditTempNode();
    }
  }

  // 将临时节点更新为实际节点
  private updateTempNodeToReal(name: string, realPath: string, isLeaf: boolean) {
    this.dataSource.updateNode(this.inlineEditState.nodeKey, (node) => {
      node.title = name;
      node.path = realPath;
      node.key = realPath;
      node.isLeaf = isLeaf;
      node.expandable = !isLeaf;
    });
  }

  // 处理输入框的键盘事件
  onInlineEditKeyDown(event: KeyboardEvent, inputElement: HTMLInputElement) {
    switch (event.key) {
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        void this.finishInlineEdit(inputElement.value);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.cancelInlineEdit();
        break;
    }
  }

  // 处理输入框失去焦点
  onInlineEditBlur(inputElement: HTMLInputElement) {
    // 延迟一小段时间，允许其他事件（如Enter键）先处理
    setTimeout(() => {
      if (this.inlineEditState.isEditing) {
        void this.finishInlineEdit(inputElement.value);
      }
    }, 100);
  }
}
