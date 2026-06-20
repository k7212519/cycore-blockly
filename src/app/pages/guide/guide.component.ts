import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
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

@Component({
  selector: 'app-guide',
  imports: [CommonModule, TranslateModule, NzButtonModule, NzPaginationModule, NzToolTipModule],
  templateUrl: './guide.component.html',
  styleUrl: './guide.component.scss'
})
export class GuideComponent implements OnInit {
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

  get recentlyProjects() {
    return this.projectService.recentlyProjects
  }

  get quickActions() {
    return this.guideMenu.filter(item => !item.sep);
  }

  get isLightTheme() {
    return this.configService.data?.theme === 'light';
  }

  constructor(
    private uiService: UiService,
    private projectService: ProjectService,
    private router: Router,
    private electronService: ElectronService,
    private message: NzMessageService,
    private configService: ConfigService
  ) { }

  ngOnInit(): void {
    this.loadProjects();
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
    } catch (error) {
      this.projects = [];
      this.total = 0;
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
