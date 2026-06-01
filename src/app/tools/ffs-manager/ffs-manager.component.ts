import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { MenuComponent } from '../../components/menu/menu.component';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { PortItem, SerialService } from '../../services/serial.service';
import { UiService } from '../../services/ui.service';
import { BAUDRATE_LIST } from '../serial-monitor/config';
import { DeviceInfoComponent } from './components/device-info/device-info.component';
import { FilesystemManagerComponent } from './components/filesystem-manager/filesystem-manager.component';
import { PartitionMapComponent } from './components/partition-map/partition-map.component';
import { FfsFileEntry, FfsFilesystemContentService, FfsFilesystemUsage, FfsMountedFilesystem } from './ffs-filesystem-content.service';
import { FfsDeviceInfo, FfsFilesystemType, FfsManagerService, FfsPartitionInfo } from './ffs-manager.service';

interface FfsUploadRestoreContext {
  port: string;
}

@Component({
  selector: 'app-ffs-manager',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzSwitchModule,
    NzToolTipModule,
    ToolContainerComponent,
    SubWindowComponent,
    MenuComponent,
    DeviceInfoComponent,
    PartitionMapComponent,
    FilesystemManagerComponent
  ],
  templateUrl: './ffs-manager.component.html',
  styleUrl: './ffs-manager.component.scss'
})
export class FfsManagerComponent {
  private destroyRef = inject(DestroyRef);
  private uploadRestoreContext: FfsUploadRestoreContext | null = null;

  private readonly defaultBaudRate = 921600;

  currentUrl = '';
  currentPort = '';
  currentBaudRate = String(this.defaultBaudRate);
  portList: PortItem[] = [];
  baudList = BAUDRATE_LIST;
  showPortList = false;
  showBaudList = false;
  position = { x: 0, y: 0 };

  switchValue = false;
  esptoolReady = false;
  busy = false;
  statusText = '选择 ESP32 串口后刷新设备信息';
  errorText = '';
  deviceInfo: FfsDeviceInfo | null = null;
  partitions: FfsPartitionInfo[] = [];
  selectedPartition: FfsPartitionInfo | null = null;
  filesystemSession: FfsMountedFilesystem | null = null;
  filesystemFiles: FfsFileEntry[] = [];
  selectedFile: FfsFileEntry | null = null;
  filesystemUsage: FfsFilesystemUsage | null = null;
  filesystemDirty = false;
  filesystemStatusText = '读取文件列表后可管理分区内容';

  constructor(
    private router: Router,
    private uiService: UiService,
    private serialService: SerialService,
    private ffsManagerService: FfsManagerService,
    private ffsFilesystemContentService: FfsFilesystemContentService,
    private message: NzMessageService,
    private modal: NzModalService,
    private cd: ChangeDetectorRef
  ) { }

  async ngOnInit() {
    this.currentUrl = this.router.url;
    if (this.serialService.currentPort && this.serialService.currentPortInfo?.type !== 'debugger') {
      this.currentPort = this.serialService.currentPort;
    }
    await this.checkEsptool();
    await this.checkAndSetDefaultPort();

    // 监听工具信号，处理上传过程中的串口断开/重连
    this.uiService.actionSubject
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((action: any) => {
        if (action?.action === 'signal' && action?.type === 'tool') {
          const signal = action.data as string;
          if (signal === 'serial-monitor:disconnect') {
            this.pauseForUpload(this.getUploadPortFromSignal(action));
          } else if (signal === 'serial-monitor:connect') {
            this.restoreAfterUpload(this.getUploadPortFromSignal(action));
          }
        }
      });
  }

  async ngOnDestroy() {
    try {
      await this.ffsManagerService.release(true);
    } catch (error) {
      console.warn('[FfsManager] 释放 ESP 会话失败:', error);
    }
  }

  private getUploadPortFromSignal(action: any): string | null {
    return action?.payload?.port || this.serialService.currentPort || null;
  }

  private async pauseForUpload(uploadPort: string | null) {
    this.uploadRestoreContext = null;
    if (!uploadPort || !this.switchValue || this.currentPort !== uploadPort) {
      return;
    }

    this.uploadRestoreContext = { port: uploadPort };
    this.switchValue = false;
    this.statusText = '已暂停 ESP 会话以便固件烧录...';
    this.cd.detectChanges();

    try {
      // 不做 hardReset，让上传工具自行驱动 boot 流程
      await this.ffsManagerService.release(false);
    } catch (error) {
      console.warn('[FfsManager] 上传前释放 ESP 会话失败:', error);
    }
    this.deviceInfo = null;
    this.partitions = [];
    this.selectedPartition = null;
    this.resetFilesystemState();
    this.cd.detectChanges();
  }

  private async restoreAfterUpload(uploadPort: string | null) {
    const context = this.uploadRestoreContext;
    this.uploadRestoreContext = null;
    if (!context || !uploadPort || context.port !== uploadPort || this.switchValue) {
      return;
    }

    this.currentPort = context.port;
    this.switchValue = true;
    this.statusText = '固件烧录完成，正在重新连接 ESP...';
    this.cd.detectChanges();

    try {
      await this.refreshAll();
      if (this.errorText || !this.deviceInfo) {
        this.switchValue = false;
        try {
          await this.ffsManagerService.release(true);
        } catch { }
      }
    } catch (error) {
      console.warn('[FfsManager] 上传后重新连接 ESP 失败:', error);
      this.switchValue = false;
    }
    this.cd.detectChanges();
  }

  get filesystemPartitions() {
    return this.partitions.filter(partition => partition.filesystemType);
  }

  get selectedFilesystemLabel() {
    return this.getFsLabel(this.selectedPartition?.filesystemType || null);
  }

  get canManageSelectedPartition() {
    return Boolean(this.currentPort && this.selectedPartition?.filesystemType && !this.busy);
  }

  get hasFilesystemSession() {
    return Boolean(this.filesystemSession);
  }

  get canSaveFilesystemContent() {
    return Boolean(this.filesystemSession && this.filesystemDirty && this.currentPort && !this.busy);
  }

  async close() {
    try {
      await this.ffsManagerService.release(true);
    } catch (error) {
      console.warn('[FfsManager] 关闭工具时释放 ESP 会话失败:', error);
    }
    this.uiService.closeTool('ffs-manager');
  }

  async refreshAll() {
    if (!this.currentPort) {
      this.message.warning('请先选择串口');
      return;
    }

    if (!this.esptoolReady) {
      await this.checkEsptool(true);
      if (!this.esptoolReady) {
        this.message.warning('未检测到 esptool');
        return;
      }
    }

    this.busy = true;
    this.errorText = '';
    this.statusText = '正在读取设备信息...';
    this.cd.detectChanges();

    try {
      const baudRate = this.getSelectedBaudRate();
      this.deviceInfo = await this.ffsManagerService.readDeviceInfo(this.currentPort, baudRate);
      this.statusText = '正在读取分区表...';
      this.cd.detectChanges();
      this.partitions = await this.ffsManagerService.readPartitionTable(this.currentPort, baudRate);
      this.selectedPartition = this.filesystemPartitions[0] || this.partitions[0] || null;
      this.resetFilesystemState();
      this.statusText = this.partitions.length
        ? `已读取 ${this.partitions.length} 个分区，其中 ${this.filesystemPartitions.length} 个文件系统分区`
        : '没有读取到分区表';
    } catch (error) {
      this.errorText = this.formatError(error);
      this.statusText = '读取失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async switchConnection() {
    if (this.switchValue) {
      if (!this.currentPort) {
        this.message.warning('请先选择串口');
        this.switchValue = false;
        return;
      }
      await this.refreshAll();
      // 任何步骤失败则把开关复位为关
      if (this.errorText || !this.deviceInfo) {
        this.switchValue = false;
        try {
          await this.ffsManagerService.release(true);
        } catch { }
      }
      this.cd.detectChanges();
    } else {
      try {
        await this.ffsManagerService.release(true);
      } catch (error) {
        console.warn('[FfsManager] 断开 ESP 会话失败:', error);
      }
      this.deviceInfo = null;
      this.partitions = [];
      this.selectedPartition = null;
      this.resetFilesystemState();
      this.statusText = '已断开';
      this.cd.detectChanges();
    }
  }

  async selectPartition(partition: FfsPartitionInfo) {
    if (this.selectedPartition?.index === partition.index) return;
    if (this.filesystemDirty && !(await this.confirmDialog('切换分区', '当前文件系统有未写回修改，切换分区将丢弃这些修改，是否继续？'))) {
      return;
    }
    this.selectedPartition = partition;
    this.resetFilesystemState();
  }

  async loadFilesystemContent() {
    const partition = this.selectedPartition;
    if (!partition?.filesystemType || !this.currentPort) return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = `正在读取 ${partition.label || partition.offsetHex} 文件系统...`;
    try {
      const image = await this.ffsManagerService.readPartitionImage(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition
      );
      this.filesystemSession = await this.ffsFilesystemContentService.mountPartition(partition, image);
      this.filesystemFiles = this.filesystemSession.files;
      this.filesystemUsage = this.filesystemSession.usage;
      this.filesystemDirty = false;
      this.selectedFile = null;
      this.filesystemStatusText = `已读取 ${this.filesystemFiles.length} 个文件系统条目`;
      this.message.success('文件系统内容已读取');
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = '文件系统读取失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async uploadFileToFilesystem(file: File) {
    const session = this.filesystemSession;
    if (!file || !session) return;

    const defaultPath = this.ffsFilesystemContentService.getDefaultUploadPath(file.name, session.type);
    const targetPath = await this.promptDialog('上传文件', defaultPath, '/path/to/file');
    if (targetPath === null || !targetPath.trim()) return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = `正在上传 ${file.name}...`;
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      await this.ffsFilesystemContentService.writeFile(session, targetPath, data);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = `${file.name} 已加入文件系统，需写回设备后生效`;
      this.message.success('文件已上传到镜像');
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = '上传失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async downloadFilesystemFile(entry: FfsFileEntry) {
    const session = this.filesystemSession;
    if (!session || entry.type !== 'file') return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = `正在下载 ${entry.path}...`;
    try {
      const data = await this.ffsFilesystemContentService.readFile(session, entry.path);
      const saved = await this.saveBinaryFile(entry.name, data, '保存文件');
      this.filesystemStatusText = saved ? `${entry.path} 已下载` : '已取消下载';
      if (saved) {
        this.message.success('文件已下载');
      }
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = '下载失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async deleteFilesystemEntry(entry: FfsFileEntry) {
    const session = this.filesystemSession;
    if (!session) return;
    const typeText = entry.type === 'dir' ? '目录' : '文件';
    if (!(await this.confirmDialog('删除确认', `确认删除${typeText} ${entry.path}？`))) {
      return;
    }

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = `正在删除 ${entry.path}...`;
    try {
      await this.ffsFilesystemContentService.deleteEntry(session, entry);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = `${entry.path} 已删除，需写回设备后生效`;
      this.message.success('文件系统条目已删除');
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = '删除失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async renameFilesystemEntry(entry: FfsFileEntry) {
    const session = this.filesystemSession;
    if (!session) return;

    const nextPath = await this.promptDialog('重命名', entry.path, '新的路径');
    if (nextPath === null || nextPath.trim() === entry.path) return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = `正在重命名 ${entry.path}...`;
    try {
      await this.ffsFilesystemContentService.renameEntry(session, entry, nextPath);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = `${entry.path} 已重命名，需写回设备后生效`;
      this.message.success('文件系统条目已重命名');
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = '重命名失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async createFilesystemDirectory() {
    const session = this.filesystemSession;
    if (!session) return;

    const path = await this.promptDialog('新建目录', '/new_folder', '/path/to/dir');
    if (path === null || !path.trim()) return;

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = `正在创建目录 ${path}...`;
    try {
      await this.ffsFilesystemContentService.mkdir(session, path);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = `${path} 已创建，需写回设备后生效`;
      this.message.success('目录已创建');
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = '创建目录失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async formatFilesystemContent() {
    const session = this.filesystemSession;
    if (!session) return;
    if (!(await this.confirmDialog('格式化确认', '确认格式化当前文件系统镜像？写回设备后原文件将被清空。'))) {
      return;
    }

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = '正在格式化文件系统镜像...';
    try {
      await this.ffsFilesystemContentService.format(session);
      await this.refreshFilesystemSession(true);
      this.filesystemStatusText = '文件系统镜像已格式化，需写回设备后生效';
      this.message.success('文件系统镜像已格式化');
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = '格式化失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async saveFilesystemContent() {
    const session = this.filesystemSession;
    const partition = this.selectedPartition;
    if (!session || !partition || !this.currentPort) return;
    if (!(await this.confirmDialog('写回设备', `确认将当前 ${this.getFsLabel(session.type)} 镜像写回 ${partition.label || partition.offsetHex} 分区？`))) {
      return;
    }

    this.busy = true;
    this.errorText = '';
    this.filesystemStatusText = '正在导出镜像并写回设备...';
    try {
      const image = await this.ffsFilesystemContentService.toImage(session);
      if (image.length !== partition.size) {
        throw new Error(`导出的镜像大小 ${this.ffsFilesystemContentService.formatBytes(image.length)} 与分区大小 ${partition.sizeText} 不一致`);
      }
      await this.ffsManagerService.writePartitionImage(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition,
        image
      );
      session.image = image;
      this.filesystemDirty = false;
      this.filesystemStatusText = '文件系统内容已写回设备';
      this.message.success('文件系统内容已写回设备');
    } catch (error) {
      this.errorText = this.formatError(error);
      this.filesystemStatusText = '写回失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  selectFilesystemFile(entry: FfsFileEntry) {
    this.selectedFile = entry;
  }

  async downloadSelectedPartition() {
    const partition = this.selectedPartition;
    if (!partition || !partition.filesystemType || !this.currentPort) return;

    this.busy = true;
    this.statusText = `正在导出 ${partition.label || partition.offsetHex}...`;
    try {
      const data = await this.ffsManagerService.readPartitionImage(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition
      );
      const saved = await this.saveBinaryFile(this.ffsManagerService.buildPartitionFileName(partition), data, '保存分区镜像', [{ name: 'Binary image', extensions: ['bin'] }]);
      this.statusText = saved ? '分区镜像已导出' : '已取消导出';
      if (saved) {
        this.message.success('分区镜像已导出');
      }
    } catch (error) {
      this.errorText = this.formatError(error);
      this.statusText = '导出失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async restoreSelectedPartition(file: File) {
    const partition = this.selectedPartition;
    if (!file || !partition || !this.currentPort) return;

    const data = new Uint8Array(await file.arrayBuffer());
    if (data.length !== partition.size) {
      this.message.warning(`镜像大小必须等于 ${partition.sizeText}`);
      return;
    }

    if (!(await this.confirmDialog('恢复镜像', `确认将 ${file.name} 写入 ${partition.label || partition.offsetHex} 分区？`))) {
      return;
    }

    this.busy = true;
    this.statusText = `正在恢复 ${partition.label || partition.offsetHex}...`;
    try {
      await this.ffsManagerService.writePartitionImage(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition,
        data
      );
      this.statusText = '分区镜像已写入';
      this.message.success('分区镜像已写入');
    } catch (error) {
      this.errorText = this.formatError(error);
      this.statusText = '恢复失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  async eraseSelectedPartition() {
    const partition = this.selectedPartition;
    if (!partition || !partition.filesystemType || !this.currentPort) return;
    if (!(await this.confirmDialog('擦除分区', `确认擦除 ${partition.label || partition.offsetHex} 分区？该操作不可撤销。`))) {
      return;
    }

    this.busy = true;
    this.statusText = `正在擦除 ${partition.label || partition.offsetHex}...`;
    try {
      await this.ffsManagerService.erasePartition(
        this.currentPort,
        this.getSelectedBaudRate(),
        partition
      );
      this.statusText = '分区已擦除';
      this.message.success('分区已擦除');
    } catch (error) {
      this.errorText = this.formatError(error);
      this.statusText = '擦除失败';
      this.message.error(this.errorText);
    } finally {
      this.busy = false;
      this.cd.detectChanges();
    }
  }

  openPortList(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.getDevicePortList();
    this.showPortList = true;
  }

  async getDevicePortList() {
    const ports = await this.serialService.getSerialPorts();
    this.portList = ports?.length ? ports : [{
      name: 'Device not found',
      text: '',
      type: 'serial',
      icon: 'fa-light fa-triangle-exclamation',
      disabled: true,
    }];
  }

  closePortList() {
    this.showPortList = false;
    this.cd.detectChanges();
  }

  selectPort(portItem: PortItem) {
    if (!portItem.name) return;
    if (this.switchValue && this.currentPort !== portItem.name) {
      // 切换串口时先断开旧会话
      this.switchValue = false;
      this.ffsManagerService.release(true).catch(() => { });
      this.deviceInfo = null;
      this.partitions = [];
      this.selectedPartition = null;
      this.resetFilesystemState();
    }
    this.currentPort = portItem.name;
    this.serialService.currentPort = portItem.name;
    this.serialService.currentPortInfo = portItem;
    this.closePortList();
  }

  openBaudList(event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.position.x = rect.left;
    this.position.y = rect.bottom + 2;
    this.showBaudList = !this.showBaudList;
  }

  closeBaudList() {
    this.showBaudList = false;
    this.cd.detectChanges();
  }

  selectBaud(item: { name?: string; value?: number }) {
    this.currentBaudRate = String(item.value || item.name || this.currentBaudRate);
    this.closeBaudList();
  }

  getFsLabel(type: FfsFilesystemType | null): string {
    if (type === 'spiffs') return 'SPIFFS';
    if (type === 'littlefs') return 'LittleFS';
    if (type === 'fatfs') return 'FATFS';
    return '普通分区';
  }

  getPartitionWidth(partition: FfsPartitionInfo): number {
    const total = this.partitions.reduce((sum, item) => sum + item.size, 0);
    if (!total) return 0;
    return Math.max(2, partition.size / total * 100);
  }

  private async checkEsptool(clearCache = false) {
    const packageInfo = await this.ffsManagerService.detectEsptool(clearCache);
    this.esptoolReady = Boolean(packageInfo?.esptoolPath);
    this.cd.detectChanges();
  }

  private async checkAndSetDefaultPort() {
    if (this.currentPort) return;
    try {
      const ports = await this.serialService.getSerialPorts();
      if (ports?.length === 1 && ports[0].name) {
        this.currentPort = ports[0].name;
        this.serialService.currentPort = ports[0].name;
        this.serialService.currentPortInfo = ports[0];
        this.cd.detectChanges();
      }
    } catch (error) {
      console.warn('[FfsManager] 获取串口列表失败:', error);
    }
  }

  private async refreshFilesystemSession(dirty: boolean) {
    if (!this.filesystemSession) return;
    this.filesystemFiles = await this.ffsFilesystemContentService.listFiles(this.filesystemSession);
    this.filesystemUsage = await this.ffsFilesystemContentService.getUsage(this.filesystemSession);
    this.filesystemSession.files = this.filesystemFiles;
    this.filesystemSession.usage = this.filesystemUsage;
    this.filesystemDirty = dirty;
    this.selectedFile = null;
  }

  private getSelectedBaudRate(): number {
    return Number(this.currentBaudRate) || this.defaultBaudRate;
  }

  private resetFilesystemState() {
    this.filesystemSession = null;
    this.filesystemFiles = [];
    this.selectedFile = null;
    this.filesystemUsage = null;
    this.filesystemDirty = false;
    this.filesystemStatusText = '读取文件列表后可管理分区内容';
  }

  private async saveBinaryFile(fileName: string, data: Uint8Array, title = '保存分区镜像', filters?: Array<{ name: string; extensions: string[] }>): Promise<boolean> {
    if (window['ipcRenderer'] && window['fs']) {
      const saveOptions: any = {
        suggestedName: fileName,
        title,
      };
      if (filters) {
        saveOptions.filters = filters;
      }
      const filePath = await window['ipcRenderer'].invoke('select-folder-saveAs', saveOptions);
      if (!filePath) {
        return false;
      }
      window['fs'].writeFileSync(filePath, data);
      return true;
    }

    const blob = new Blob([data], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    return true;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error || '未知错误');
  }

  private confirmDialog(title: string, content?: string): Promise<boolean> {
    return new Promise(resolve => {
      this.modal.confirm({
        nzTitle: title,
        nzContent: content,
        nzOkText: '确认',
        nzCancelText: '取消',
        nzBodyStyle: { background: 'var(--aily-bg-primary)' },
        nzOnOk: () => resolve(true),
        nzOnCancel: () => resolve(false),
      });
    });
  }

  private promptDialog(title: string, defaultValue = '', placeholder = ''): Promise<string | null> {
    return new Promise(resolve => {
      let value = defaultValue;
      const ref = this.modal.create({
        nzTitle: title,
        nzBodyStyle: { background: 'var(--aily-bg-primary)' },
        nzContent: `<input id="ffs-prompt-input" class="ant-input" placeholder="${this.escapeHtml(placeholder)}" value="${this.escapeHtml(defaultValue)}" style="width:100%" />`,
        nzOkText: '确认',
        nzCancelText: '取消',
        nzOnOk: () => resolve(value),
        nzOnCancel: () => resolve(null),
      });
      ref.afterOpen.subscribe(() => {
        const input = document.getElementById('ffs-prompt-input') as HTMLInputElement | null;
        if (input) {
          input.focus();
          input.select();
          input.addEventListener('input', () => { value = input.value; });
          input.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              value = input.value;
              ref.triggerOk();
            }
          });
        }
      });
    });
  }

  private escapeHtml(text: string): string {
    return String(text ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    } as Record<string, string>)[c]);
  }
}