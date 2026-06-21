import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { GUIDE_MENU } from '../../configs/menu.config';
import { UiService } from '../../services/ui.service';
import { ProjectService, ServerProjectListItem } from '../../services/project.service';
import { version } from '../../../../package.json';
import { TranslateModule } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { ElectronService } from '../../services/electron.service';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzPaginationModule } from 'ng-zorro-antd/pagination';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ConfigService } from '../../services/config.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { MenuComponent } from '../../components/menu/menu.component';

interface SelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

@Component({
  selector: 'app-guide',
  imports: [CommonModule, TranslateModule, NzButtonModule, NzPaginationModule, NzToolTipModule, MenuComponent],
  templateUrl: './guide.component.html',
  styleUrl: './guide.component.scss'
})
export class GuideComponent implements OnInit, OnDestroy {
  version = version;
  guideMenu = GUIDE_MENU;
  showMenu = true;
  projects: ServerProjectListItem[] = [];
  pageIndex = 1;
  pageSize = 12;
  total = 0;
  loadingProjects = false;
  openingProjectId = '';
  loadError = '';
  selectedProjectIds = new Set<string>();
  deletingProjectIds = new Set<string>();
  selectionRect: SelectionRect | null = null;
  showProjectContextMenu = false;
  projectContextMenuPosition = { x: 0, y: 0 };
  readonly contextMenuWidth = 178;

  private selectionStart = { x: 0, y: 0 };
  private dragBaseSelection = new Set<string>();
  private dragSelecting = false;
  private dragHasMoved = false;
  private additiveSelection = false;
  private suppressNextCardClick = false;
  private pointerDownOnCard = false;
  private readonly dragThreshold = 5;

  get recentlyProjects() {
    return this.projectService.recentlyProjects
  }

  get quickActions() {
    return this.guideMenu.filter(item => !item.sep);
  }

  get isLightTheme() {
    return this.configService.data?.theme === 'light';
  }

  get selectedProjects() {
    return this.projects.filter(project => this.selectedProjectIds.has(project.projectId));
  }

  get projectContextMenu() {
    const count = Math.max(this.selectedProjects.length, 1);
    return [
      {
        name: count > 1 ? `删除 ${count} 个项目` : '删除项目',
        icon: 'fa-light fa-trash-can',
        action: 'delete-projects'
      }
    ];
  }

  get selectionRectStyle() {
    if (!this.selectionRect) {
      return null;
    }
    return {
      left: this.selectionRect.left + 'px',
      top: this.selectionRect.top + 'px',
      width: this.selectionRect.width + 'px',
      height: this.selectionRect.height + 'px'
    };
  }

  constructor(
    private uiService: UiService,
    private projectService: ProjectService,
    private router: Router,
    private electronService: ElectronService,
    private message: NzMessageService,
    private configService: ConfigService,
    private modal: NzModalService
  ) { }

  ngOnInit(): void {
    this.loadProjects();
  }

  ngOnDestroy(): void {
    this.removeSelectionListeners();
  }

  async loadProjects(page = this.pageIndex) {
    this.loadingProjects = true;
    this.loadError = '';
    try {
      const result = await this.projectService.loadServerProjects(page, this.pageSize);
      this.projects = result.records || [];
      this.total = result.total || 0;
      this.pageIndex = result.page || page;
      this.pageSize = result.pageSize || this.pageSize;
      this.trimSelectionToLoadedProjects();
    } catch (error) {
      this.projects = [];
      this.total = 0;
      this.selectedProjectIds.clear();
      this.loadError = error?.message || '项目列表加载失败';
    } finally {
      this.loadingProjects = false;
    }
  }

  onPageChange(page: number) {
    this.pageIndex = page;
    this.loadProjects(page);
  }

  onMenuClick(e: any) {
    this.process(e);
  }

  async selectFolder() {
    const folderPath = await window['ipcRenderer'].invoke('select-folder', {
      path: '',
    });
    console.log('选中的文件夹路径：', folderPath);
    return folderPath;
  }

  async openProject(data) {
    const path = await this.selectFolder();
    if (path) {
      await this.projectService.projectOpen(path);
    }
  }

  async openProjectByPath(data) {
    await this.projectService.projectOpen(data.path);
  }

  async openServerProject(project: ServerProjectListItem) {
    if (!project?.projectId || this.openingProjectId) {
      return;
    }
    this.openingProjectId = project.projectId;
    try {
      await this.projectService.projectOpenById(project.projectId);
    } catch (error) {
      this.message.error(error?.message || '项目打开失败');
    } finally {
      this.openingProjectId = '';
    }
  }

  getProjectUpdatedText(project: ServerProjectListItem) {
    return project.updateTime || project.createTime || '';
  }

  onProjectCardClick(event: MouseEvent, project: ServerProjectListItem) {
    if (this.suppressNextCardClick) {
      event.preventDefault();
      event.stopPropagation();
      this.suppressNextCardClick = false;
      return;
    }

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      this.toggleProjectSelection(project.projectId);
      return;
    }

    this.openServerProject(project);
  }

  onProjectsAreaPointerDown(event: PointerEvent) {
    if (event.button !== 0 || this.loadingProjects || this.openingProjectId) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest('.project-context-menu')) {
      return;
    }

    this.closeProjectContextMenu();
    this.pointerDownOnCard = !!target.closest('.project-card[data-project-id]');
    this.selectionStart = { x: event.clientX, y: event.clientY };
    this.dragBaseSelection = new Set(this.selectedProjectIds);
    this.additiveSelection = event.ctrlKey || event.metaKey;
    this.dragSelecting = true;
    this.dragHasMoved = false;
    this.selectionRect = null;
    window.addEventListener('pointermove', this.handleSelectionPointerMove);
    window.addEventListener('pointerup', this.handleSelectionPointerUp);
  }

  onProjectCardContextMenu(event: MouseEvent, project: ServerProjectListItem) {
    event.preventDefault();
    event.stopPropagation();

    if (!this.selectedProjectIds.has(project.projectId)) {
      this.selectedProjectIds = new Set([project.projectId]);
    }

    this.projectContextMenuPosition = {
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - this.contextMenuWidth - 8)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - 54))
    };
    this.showProjectContextMenu = true;
  }

  onProjectContextMenuClick(item: any) {
    this.closeProjectContextMenu();
    if (item?.action === 'delete-projects') {
      this.confirmDeleteSelectedProjects();
    }
  }

  closeProjectContextMenu() {
    this.showProjectContextMenu = false;
  }

  isProjectSelected(projectId: string) {
    return this.selectedProjectIds.has(projectId);
  }

  isProjectDeleting(projectId: string) {
    return this.deletingProjectIds.has(projectId);
  }

  @HostListener('document:keydown.escape')
  clearSelection() {
    this.selectedProjectIds.clear();
    this.closeProjectContextMenu();
    this.selectionRect = null;
  }

  private confirmDeleteSelectedProjects() {
    const projects = this.selectedProjects;
    if (projects.length === 0) {
      return;
    }

    const title = projects.length > 1 ? `确认删除 ${projects.length} 个项目` : '确认删除项目';
    const content = projects.length > 1
      ? `将删除所选项目及其服务器文件，此操作不可撤销。`
      : `将删除项目「${projects[0].name}」及其服务器文件，此操作不可撤销。`;

    this.modal.confirm({
      nzClassName: 'project-delete-confirm-modal',
      nzTitle: title,
      nzContent: content,
      nzOkText: '删除',
      nzOkDanger: true,
      nzCancelText: '取消',
      nzOnOk: () => this.deleteProjects(projects)
    });
  }

  private async deleteProjects(projects: ServerProjectListItem[]) {
    const ids = projects.map(project => project.projectId);
    this.deletingProjectIds = new Set(ids);
    try {
      for (const project of projects) {
        await this.projectService.deleteServerProject(project.projectId);
      }
      this.message.success(projects.length > 1 ? `已删除 ${projects.length} 个项目` : '项目已删除');
      this.selectedProjectIds.clear();
      const remainingTotal = Math.max(0, this.total - ids.length);
      const nextPage = Math.min(this.pageIndex, Math.max(1, Math.ceil(remainingTotal / this.pageSize)));
      await this.loadProjects(nextPage);
    } catch (error) {
      this.message.error(error?.message || '项目删除失败');
    } finally {
      this.deletingProjectIds.clear();
    }
  }

  private toggleProjectSelection(projectId: string) {
    const nextSelection = new Set(this.selectedProjectIds);
    if (nextSelection.has(projectId)) {
      nextSelection.delete(projectId);
    } else {
      nextSelection.add(projectId);
    }
    this.selectedProjectIds = nextSelection;
  }

  private handleSelectionPointerMove = (event: PointerEvent) => {
    if (!this.dragSelecting) {
      return;
    }

    const deltaX = event.clientX - this.selectionStart.x;
    const deltaY = event.clientY - this.selectionStart.y;
    if (!this.dragHasMoved && Math.hypot(deltaX, deltaY) < this.dragThreshold) {
      return;
    }

    event.preventDefault();
    this.dragHasMoved = true;
    this.selectionRect = {
      left: Math.min(this.selectionStart.x, event.clientX),
      top: Math.min(this.selectionStart.y, event.clientY),
      width: Math.abs(deltaX),
      height: Math.abs(deltaY)
    };
    this.updateDragSelection();
  };

  private handleSelectionPointerUp = () => {
    this.removeSelectionListeners();
    if (!this.dragHasMoved && !this.pointerDownOnCard && !this.additiveSelection) {
      this.selectedProjectIds.clear();
    }
    if (this.dragHasMoved) {
      this.suppressNextCardClick = true;
      setTimeout(() => {
        this.suppressNextCardClick = false;
      });
    }
    this.dragSelecting = false;
    this.dragHasMoved = false;
    this.selectionRect = null;
  };

  private updateDragSelection() {
    if (!this.selectionRect) {
      return;
    }

    const nextSelection = this.additiveSelection ? new Set(this.dragBaseSelection) : new Set<string>();
    const selectionBounds = this.rectToBounds(this.selectionRect);
    document.querySelectorAll<HTMLElement>('.project-card[data-project-id]').forEach(card => {
      const projectId = card.dataset['projectId'];
      if (!projectId) {
        return;
      }
      if (this.rectsIntersect(selectionBounds, card.getBoundingClientRect())) {
        nextSelection.add(projectId);
      }
    });
    this.selectedProjectIds = nextSelection;
  }

  private rectToBounds(rect: SelectionRect) {
    return {
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height
    };
  }

  private rectsIntersect(a: { left: number; top: number; right: number; bottom: number }, b: DOMRect) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  }

  private removeSelectionListeners() {
    window.removeEventListener('pointermove', this.handleSelectionPointerMove);
    window.removeEventListener('pointerup', this.handleSelectionPointerUp);
  }

  private trimSelectionToLoadedProjects() {
    const loadedIds = new Set(this.projects.map(project => project.projectId));
    this.selectedProjectIds = new Set([...this.selectedProjectIds].filter(projectId => loadedIds.has(projectId)));
  }

  process(item) {
    switch (item.action) {
      case 'project-new':
        this.router.navigate(['/main/project-new']);
        // this.uiService.openWindow(item.data);
        break;
      case 'project-open':
        this.openProject(item.data);
        break;
      case 'browser-open':
        this.electronService.openUrl(item.data.url);
        break;
      case 'playground-open':
        this.openPlayground();
        break;
      case 'tool-open':
        this.uiService.turnTool(item.data);
        break;
      default:
        break;
    }
  }

  gotoPlayground() {
    this.openPlayground();
  }

  private openPlayground() {
    this.router.navigate(['/main/playground'], {
      queryParams: { returnUrl: this.router.url }
    });
  }

  // 重新加载微信二维码图片
  // retryLoadImage() {
  //   setTimeout(() => {
  //     const img = document.querySelector('.qrcode') as HTMLImageElement;
  //     if (img) {
  //       const originalSrc = 'https://dl.diandeng.tech/blockly/wechat.jpg';
  //       img.src = `${originalSrc}?t=${Date.now()}`;
  //     }
  //   }, 1000);
  // }

  // test() {
  //   console.log(this.electronService.isWindowFocused());
  //   setTimeout(() => {
  //     // if (!this.electronService.isWindowFocused()) {
  //     // }
  //   }, 12000)
  // }

}
