import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzPopconfirmModule } from 'ng-zorro-antd/popconfirm';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import {
  FfsFileEntry,
  FfsFilesystemUsage,
  FfsMountedFilesystem,
} from '../../ffs-filesystem-content.service';
import { FfsFilesystemType, FfsPartitionInfo } from '../../ffs-manager.service';

interface ExplorerEntry {
  name: string;
  fullPath: string;       // 完整路径，目录以 / 结尾
  type: 'file' | 'dir';
  sizeText: string;
  size: number;
  source?: FfsFileEntry;  // 文件对应的原始条目（目录可能为虚拟）
}

@Component({
  selector: 'app-filesystem-manager',
  standalone: true,
  imports: [CommonModule, NzButtonModule, NzToolTipModule, NzPopconfirmModule],
  templateUrl: './filesystem-manager.component.html',
  styleUrl: './filesystem-manager.component.scss',
})
export class FilesystemManagerComponent implements OnChanges {
  @Input() selectedPartition: FfsPartitionInfo | null = null;
  @Input() filesystemSession: FfsMountedFilesystem | null = null;
  @Input() files: FfsFileEntry[] = [];
  @Input() usage: FfsFilesystemUsage | null = null;
  @Input() dirty = false;
  @Input() statusText = '';
  @Input() busy = false;
  @Input() currentPort = '';

  @Output() loadContent = new EventEmitter<void>();
  @Output() uploadFile = new EventEmitter<File>();
  @Output() createDirectory = new EventEmitter<void>();
  @Output() saveContent = new EventEmitter<void>();
  @Output() formatFilesystem = new EventEmitter<void>();
  @Output() downloadPartition = new EventEmitter<void>();
  @Output() restorePartition = new EventEmitter<File>();
  @Output() erasePartition = new EventEmitter<void>();
  @Output() downloadFile = new EventEmitter<FfsFileEntry>();
  @Output() viewEntry = new EventEmitter<FfsFileEntry>();
  @Output() renameEntry = new EventEmitter<FfsFileEntry>();
  @Output() deleteEntry = new EventEmitter<FfsFileEntry>();

  @ViewChild('restoreInput') restoreInput!: ElementRef<HTMLInputElement>;
  @ViewChild('fileUploadInput') fileUploadInput!: ElementRef<HTMLInputElement>;

  currentPath = '/';
  history: string[] = ['/'];
  historyIndex = 0;
  selectedEntry: ExplorerEntry | null = null;

  ngOnChanges(changes: SimpleChanges) {
    if (changes['filesystemSession'] || changes['selectedPartition']) {
      this.resetNavigation();
    }
    if (changes['files']) {
      this.selectedEntry = null;
    }
  }

  // ============ 计算属性 ============

  get hasSession() {
    return Boolean(this.filesystemSession);
  }

  get canManage(): boolean {
    return Boolean(this.currentPort && this.selectedPartition?.filesystemType && !this.busy);
  }

  get canSave(): boolean {
    return Boolean(this.filesystemSession && this.dirty && this.currentPort && !this.busy);
  }

  get fsLabel(): string {
    return this.getFsLabel(this.filesystemSession?.type || this.selectedPartition?.filesystemType || null);
  }

  get isFilesystemPartition(): boolean {
    return Boolean(this.selectedPartition?.filesystemType);
  }

  get supportsDirectory(): boolean {
    const t = this.filesystemSession?.type || this.selectedPartition?.filesystemType;
    return t === 'littlefs' || t === 'fatfs';
  }

  get breadcrumbs(): { name: string; path: string }[] {
    const segs = this.currentPath.split('/').filter(Boolean);
    const items: { name: string; path: string }[] = [{ name: '根目录', path: '/' }];
    let acc = '';
    for (const s of segs) {
      acc += '/' + s;
      items.push({ name: s, path: acc });
    }
    return items;
  }

  /** 当前目录下显示的条目（目录优先 → 名称排序） */
  get displayEntries(): ExplorerEntry[] {
    if (!this.files?.length) return [];
    const prefix = this.currentPath === '/' ? '/' : this.currentPath + '/';
    const dirMap = new Map<string, ExplorerEntry>();
    const fileList: ExplorerEntry[] = [];

    for (const f of this.files) {
      const path = f.path.startsWith('/') ? f.path : '/' + f.path;
      if (!path.startsWith(prefix) && path !== this.currentPath) continue;
      const rel = path.slice(prefix.length);
      if (!rel) continue;
      const slash = rel.indexOf('/');

      if (f.type === 'dir') {
        // 目录条目：可能位于当前层或子层
        if (slash === -1) {
          // 直接子目录
          const full = prefix + rel;
          dirMap.set(rel, {
            name: rel,
            fullPath: full.endsWith('/') ? full : full + '/',
            type: 'dir',
            sizeText: '',
            size: 0,
            source: f,
          });
        } else {
          // 子层级的目录推断出当前层目录
          const dirName = rel.slice(0, slash);
          if (!dirMap.has(dirName)) {
            dirMap.set(dirName, {
              name: dirName,
              fullPath: prefix + dirName + '/',
              type: 'dir',
              sizeText: '',
              size: 0,
            });
          }
        }
      } else {
        if (slash === -1) {
          // 当前层文件
          fileList.push({
            name: rel,
            fullPath: prefix + rel,
            type: 'file',
            sizeText: f.sizeText,
            size: f.size,
            source: f,
          });
        } else {
          // 文件位于子目录，推断出当前层目录
          const dirName = rel.slice(0, slash);
          if (!dirMap.has(dirName)) {
            dirMap.set(dirName, {
              name: dirName,
              fullPath: prefix + dirName + '/',
              type: 'dir',
              sizeText: '',
              size: 0,
            });
          }
        }
      }
    }

    const dirs = Array.from(dirMap.values()).sort((a, b) => a.name.localeCompare(b.name));
    fileList.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...fileList];
  }

  /** 全部项数（含子目录中文件） */
  get totalEntryCount(): number {
    return this.files?.length || 0;
  }

  // ============ 导航 ============

  goBack() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.currentPath = this.history[this.historyIndex];
      this.selectedEntry = null;
    }
  }

  goForward() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.currentPath = this.history[this.historyIndex];
      this.selectedEntry = null;
    }
  }

  goUp() {
    if (this.currentPath === '/') return;
    const idx = this.currentPath.lastIndexOf('/');
    const parent = idx <= 0 ? '/' : this.currentPath.slice(0, idx);
    this.navigateTo(parent);
  }

  navigateTo(path: string) {
    const next = path || '/';
    if (next === this.currentPath) return;
    // 截断 forward 历史
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(next);
    this.historyIndex = this.history.length - 1;
    this.currentPath = next;
    this.selectedEntry = null;
  }

  // ============ 用户交互 ============

  onEntryClick(entry: ExplorerEntry) {
    this.selectedEntry = entry;
  }

  onEntryDoubleClick(entry: ExplorerEntry) {
    if (entry.type === 'dir') {
      const target = entry.fullPath.replace(/\/$/, '') || '/';
      this.navigateTo(target);
    } else if (entry.source) {
      this.downloadFile.emit(entry.source);
    }
  }

  refreshList() {
    this.loadContent.emit();
  }

  triggerUploadFile() {
    if (!this.hasSession || this.busy) return;
    this.fileUploadInput.nativeElement.value = '';
    this.fileUploadInput.nativeElement.click();
  }

  onUploadInputChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.uploadFile.emit(file);
    input.value = '';
  }

  triggerRestore() {
    if (!this.canManage) return;
    this.restoreInput.nativeElement.value = '';
    this.restoreInput.nativeElement.click();
  }

  onRestoreInputChange(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) this.restorePartition.emit(file);
    input.value = '';
  }

  emitDownload(entry: ExplorerEntry, evt: MouseEvent) {
    evt.stopPropagation();
    if (entry.source) this.downloadFile.emit(entry.source);
  }

  emitView(entry: ExplorerEntry, evt: MouseEvent) {
    evt.stopPropagation();
    if (entry.source) this.viewEntry.emit(entry.source);
  }

  emitRename(entry: ExplorerEntry, evt: MouseEvent) {
    evt.stopPropagation();
    if (entry.source) this.renameEntry.emit(entry.source);
  }

  emitDelete(entry: ExplorerEntry, evt: MouseEvent) {
    evt.stopPropagation();
    if (entry.source) this.deleteEntry.emit(entry.source);
  }

  // ============ 工具 ============

  getFsLabel(type: FfsFilesystemType | null): string {
    if (type === 'spiffs') return 'SPIFFS';
    if (type === 'littlefs') return 'LittleFS';
    if (type === 'fatfs') return 'FATFS';
    return '普通分区';
  }

  getIconClass(entry: ExplorerEntry): string {
    if (entry.type === 'dir') return 'fa-light fa-folder';
    const ext = entry.name.split('.').pop()?.toLowerCase() || '';
    if (['txt', 'log', 'md', 'cfg', 'ini', 'conf'].includes(ext)) return 'fa-light fa-file-lines';
    if (['json', 'yaml', 'yml', 'xml', 'toml'].includes(ext)) return 'fa-light fa-file-code';
    if (['js', 'ts', 'py', 'c', 'cpp', 'h', 'hpp', 'sh'].includes(ext)) return 'fa-light fa-file-code';
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) return 'fa-light fa-file-image';
    if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return 'fa-light fa-file-audio';
    if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'fa-light fa-file-video';
    if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return 'fa-light fa-file-zipper';
    if (ext === 'bin') return 'fa-light fa-file-binary';
    return 'fa-light fa-file';
  }

  getTypeLabel(entry: ExplorerEntry): string {
    if (entry.type === 'dir') return '文件夹';
    const ext = entry.name.split('.').pop()?.toUpperCase();
    return ext ? `${ext} 文件` : '文件';
  }

  getPreviewMode(name: string): 'text' | 'image' | 'audio' | null {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'].includes(ext)) return 'image';
    if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
    if (['txt', 'log', 'md', 'cfg', 'ini', 'conf', 'json', 'yaml', 'yml', 'xml', 'toml',
         'js', 'ts', 'py', 'c', 'cpp', 'h', 'hpp', 'sh', 'csv', 'html', 'htm', 'css'].includes(ext)) return 'text';
    return null;
  }

  isViewable(entry: ExplorerEntry): boolean {
    return entry.type === 'file' && this.getPreviewMode(entry.name) !== null;
  }

  getPreviewIcon(name: string): string {
    const mode = this.getPreviewMode(name);
    if (mode === 'image') return 'fa-light fa-image';
    if (mode === 'audio') return 'fa-light fa-headphones';
    return 'fa-light fa-eye';
  }

  getPreviewLabel(name: string): string {
    const mode = this.getPreviewMode(name);
    if (mode === 'audio') return '试听';
    return '查看';
  }

  trackEntry = (_: number, entry: ExplorerEntry) => entry.fullPath;

  private resetNavigation() {
    this.currentPath = '/';
    this.history = ['/'];
    this.historyIndex = 0;
    this.selectedEntry = null;
  }
}
