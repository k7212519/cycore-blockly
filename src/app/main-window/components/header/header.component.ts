import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectorRef, Component, ElementRef, isDevMode, OnDestroy, ViewChild } from '@angular/core';
import { HEADER_BTNS, HEADER_MENU } from '../../../configs/menu.config';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { ProjectService } from '../../../services/project.service';
import { UiService } from '../../../services/ui.service';
import { BuilderService } from '../../../services/builder.service';
import { UploaderService } from '../../../services/uploader.service';
import { MenuComponent } from '../../../components/menu/menu.component';
import { PortItem, SerialService } from '../../../services/serial.service';
import { ActBtnComponent } from '../act-btn/act-btn.component';
import { IMenuItem } from '../../../configs/menu.config';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzModalService } from 'ng-zorro-antd/modal';
import { UnsaveDialogComponent } from '../unsave-dialog/unsave-dialog.component';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NavigationEnd, Router } from '@angular/router';
import { BrowserService } from '../../../services/browser.service';
import { ConfigService } from '../../../services/config.service';
import { BoardSelectorDialogComponent } from '../board-selector-dialog/board-selector-dialog.component';
import { PlatformService } from '../../../services/platform.service';
// import { AppStoreService } from '../../../tools/app-store/app-store.service';
import { AppItem } from '../../../tools/app-store/app-store.config';
import { APP_LIST } from '../../../configs/tool.config';
import { EdaAuthService } from '../../../auth/eda-auth.service';
import { firstValueFrom, Subscription } from 'rxjs';
import { ThemeService } from '../../../services/theme.service';
import { ActionService } from '../../../services/action.service';
import { getApiBaseUrl, getIotPlatformUrl } from '../../../configs/api.config';
import { ProcessState, WorkflowService } from '../../../services/workflow.service';
import { ProjectImportDialogComponent } from '../../../components/project-import-dialog/project-import-dialog.component';

@Component({
  selector: 'app-header',
  imports: [
    CommonModule,
    NzToolTipModule,
    MenuComponent,
    ActBtnComponent,
    TranslateModule
  ],
  templateUrl: './header.component.html',
  styleUrl: './header.component.scss',
})
export class HeaderComponent implements OnDestroy {
  @ViewChild('headerBox') headerBox?: ElementRef<HTMLElement>;
  @ViewChild('projectTitleInput') projectTitleInput?: ElementRef<HTMLInputElement>;

  headerBtns = HEADER_BTNS;
  headerMenu = HEADER_MENU;
  headerApps = APP_LIST;

  get projectShortcutBtns(): IMenuItem[] {
    return ['project-list', 'project-new']
      .map(action => this.headerMenu.find(item => item.action === action))
      .filter((item): item is IMenuItem => Boolean(item));
  }

  private serialPortsChangedSubscription?: Subscription;
  private routeEventsSubscription?: Subscription;
  private workflowStateSubscription?: Subscription;
  private projectTitleResizeObserver?: ResizeObserver;
  private projectTitleLayoutFrame = 0;
  private readonly projectTitleMinWidth = 120;
  private readonly projectTitleSafeGap = 14;
  private readonly hideProjectActionsWidth = 960;
  private readonly collapseHeaderToolsWidth = 760;
  private unsaveDialogOpen = false; // 标记未保存对话框是否已打开
  isEditingProjectTitle = false;
  projectTitleDraft = '';
  projectTitleSaving = false;
  hideProjectTitle = false;
  projectTitleMaxWidth = 240;
  hideProjectActions = false;
  collapseHeaderTools = false;
  showHeaderToolsMenu = false;
  headerToolsMenuPosition = { x: 40, y: 64 };

  get projectData() {
    return this.projectService.currentPackageData;
  }

  get projectTitle(): string {
    return this.projectData?.nickname || this.projectData?.name || '';
  }

  get openToolList() {
    return this.uiService.openToolList;
  }

  get terminalIsOpen() {
    return this.uiService.terminalIsOpen;
  }

  get currentPort() {
    return this.serialService.currentPort;
  }

  set currentPort(port) {
    this.serialService.currentPort = port;
  }

  get currentBoard() {
    return this.projectService.currentBoardConfig?.name;
  }

  currentUrl = null;

  get isDevMode() {
    return this.configService.isDevMode;
  }

  get themeToggleIcon(): string {
    return this.themeService.isLight ? 'fa-light fa-moon' : 'fa-light fa-sun-bright';
  }

  get themeToggleTitle(): string {
    return this.themeService.isLight ? 'MENU.SWITCH_TO_DARK' : 'MENU.SWITCH_TO_LIGHT';
  }

  get isGuideRoute(): boolean {
    return this.router.url.indexOf('/main/guide') > -1;
  }

  get headerToolsMenuList(): IMenuItem[] {
    const compileItems = this.headerBtns.filter((btn) => btn.action === 'compile' && this.showInRouter(btn));
    const appItems = this.headerApps.filter((app) => (!app.dev || this.isDevMode) && this.showInRouter(app));
    const items: IMenuItem[] = [...compileItems];

    if (appItems.length) {
      if (items.length) {
        items.push({ sep: true });
      }
      items.push(...appItems);
    }

    if (items.length) {
      items.push({ sep: true });
    }
    items.push({
      name: this.themeToggleTitle,
      action: 'theme-toggle',
      icon: this.themeToggleIcon,
    });

    return items;
  }

  // 从 AppStoreService 获取要显示在 header 上的 apps
  // get headerApps(): AppItem[] {
  //   return this.appStoreService.getHeaderApps();
  // }

  constructor(
    private projectService: ProjectService,
    private uiService: UiService,
    private builderService: BuilderService,
    private uploaderService: UploaderService,
    private serialService: SerialService,
    private cd: ChangeDetectorRef,
    private message: NzMessageService,
    private modal: NzModalService,
    private router: Router,
    private browserService: BrowserService,
    private configService: ConfigService,
    private edaAuthService: EdaAuthService,
    private translate: TranslateService,
    private platformService: PlatformService,
    private themeService: ThemeService,
    private actionService: ActionService,
    private http: HttpClient,
    private workflowService: WorkflowService,
    // private appStoreService: AppStoreService
  ) { }

  async toggleTheme(): Promise<void> {
    const nextTheme = this.themeService.isLight ? 'dark' : 'light';
    await this.themeService.confirm(nextTheme);
  }

  startProjectTitleEdit(): void {
    if (!this.isLoaded() || this.projectTitleSaving || this.isEditingProjectTitle || !this.projectService.currentProjectId) {
      return;
    }
    this.projectTitleDraft = this.projectTitle;
    this.isEditingProjectTitle = true;
    this.cd.detectChanges();
    setTimeout(() => {
      const input = this.projectTitleInput?.nativeElement;
      input?.focus();
      input?.select();
      this.scheduleProjectTitleLayout();
    }, 0);
  }

  onProjectTitleInput(event: Event): void {
    this.projectTitleDraft = (event.target as HTMLInputElement).value;
  }

  onProjectTitleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.commitProjectTitleEdit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelProjectTitleEdit();
    }
  }

  cancelProjectTitleEdit(): void {
    this.isEditingProjectTitle = false;
    this.projectTitleSaving = false;
    this.projectTitleDraft = '';
    this.scheduleProjectTitleLayout();
  }

  async commitProjectTitleEdit(): Promise<void> {
    if (!this.isEditingProjectTitle || this.projectTitleSaving) {
      return;
    }
    const nextTitle = (this.projectTitleDraft || '').trim();
    const currentTitle = (this.projectTitle || '').trim();
    if (!nextTitle) {
      this.message.warning(this.translate.instant('PROJECT.RENAME_TITLE_EMPTY'));
      setTimeout(() => this.projectTitleInput?.nativeElement?.focus(), 0);
      return;
    }
    if (nextTitle === currentTitle) {
      this.cancelProjectTitleEdit();
      return;
    }

    this.projectTitleSaving = true;
    try {
      const projectInfo = await this.projectService.updateServerProject(this.projectService.currentProjectId, nextTitle);
      const packageJson = projectInfo.packageJson || { name: projectInfo.name };
      const displayTitle = packageJson.nickname || packageJson.name || projectInfo.name;
      this.browserService.setTitle(`CYCORE-MCU-DevCloud - ${displayTitle}`);
      this.message.success(this.translate.instant('PROJECT.RENAME_TITLE_SUCCESS'));
      this.cancelProjectTitleEdit();
      this.cd.detectChanges();
    } catch (error) {
      const fallback = this.translate.instant('PROJECT.RENAME_TITLE_FAILED');
      this.message.error(error?.error?.message || error?.message || fallback);
      this.projectTitleSaving = false;
      setTimeout(() => this.projectTitleInput?.nativeElement?.focus(), 0);
    }
  }

  async ngAfterViewInit() {
    this.observeProjectTitleLayout();
    this.scheduleProjectTitleLayout();

    this.projectService.stateSubject.subscribe((state) => {
      if (state == 'loaded' || state == 'saved') {
        // 将headerMenu中有disabled的按钮置为可用
        this.headerMenu.forEach((menu) => {
          if (menu.disabled) {
            menu.disabled = false;
          }
        });

        // headerBtns中的按钮都置为默认状态
        // this.headerBtns.forEach((btnGroup) => {
        //   btnGroup.forEach((btn) => {
        //     btn.state = 'default';
        //   });
        // });
      } else {
        // 将headerMenu中有disabled的按钮置禁用
        this.headerMenu.forEach((menu) => {
          if (menu.disabled === false) {
            menu.disabled = true;
          }
        });
      }
      // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
      setTimeout(() => {
        this.cd.detectChanges();
        this.scheduleProjectTitleLayout();
      }, 0);
    });

    this.listenShortcutKeys();

    this.routeEventsSubscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        setTimeout(() => this.scheduleProjectTitleLayout(), 0);
      }
    });

    this.serialPortsChangedSubscription = this.serialService.portsChanged$.subscribe(async () => {
      if (this.showPortList) {
        await this.getDevicePortList();
      }
      setTimeout(() => {
        this.cd.detectChanges();
        this.scheduleProjectTitleLayout();
      }, 0);
    });

    this.workflowStateSubscription = this.workflowService.state$.subscribe((state) => {
      if (state !== ProcessState.ERROR) return;
      const error = this.workflowService.currentError || '';
      const actionState: RunState['state'] = /cancel|\u53d6\u6d88/i.test(error) ? 'warn' : 'error';
      let changed = false;
      this.headerBtns.forEach((btn) => {
        if (btn.state === 'doing') {
          btn.state = actionState;
          changed = true;
        }
      });
      if (changed) {
        setTimeout(() => this.cd.detectChanges(), 0);
      }
    });

    this.checkAndSetDefaultPort();
  }

  // 检查串口列表并设置默认串口
  private async checkAndSetDefaultPort() {
    try {
      const ports = await this.serialService.getSerialPorts();
      if (ports && ports.length === 1 && !this.currentPort) {
        // 只有一个串口且当前没有选择串口时，设为默认
        this.currentPort = ports[0].name;
        // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
        setTimeout(() => {
          this.cd.detectChanges();
          this.scheduleProjectTitleLayout();
        }, 0);
      }
    } catch (error) {
      console.warn('获取串口列表失败:', error);
    }
  }

  showMenu = false;
  headerMenuPosition = { x: 12, y: 64 };

  openMenu(event?: MouseEvent) {
    if (event) {
      this.headerMenuPosition = this.calculateDropdownPosition(event, 250, 360);
    }
    this.showMenu = !this.showMenu;
  }

  closeMenu() {
    this.showMenu = false;
  }

  showPortList = false;
  configList: PortItem[] = []
  boardKeywords = []; // 这个用来高亮显示正确开发板，如['arduino uno']，则端口菜单中如有包含'arduino uno'的串口则高亮显示
  openPortList(event?: MouseEvent) {
    if (event) {
      this.calculatePortListPosition(event);
    } else {
      // 快捷键触发时，查找上传按钮元素获取位置
      const uploadBtn = document.querySelector('[data-action="upload"]') as HTMLElement;
      if (uploadBtn) {
        const rect = uploadBtn.getBoundingClientRect();
        this.portListPosition = this.clampDropdownPosition(rect.left + 2, rect.bottom + 2, 260, 400);
      } else {
        // 备用位置
        this.portListPosition = this.getHeaderFallbackPosition();
      }
    }
    let boardname = (this.currentBoard || '').replace(' 2560', ' ').replace(' R3', '');
    this.boardKeywords = [boardname];
    this.getDevicePortList();
    this.showPortList = true;
    // this.cd.detectChanges();
  }

  closePortList() {
    this.showPortList = false;
    // this.cd.detectChanges();
  }

  selectPort(item) {
    if (item.action) {
      this.process(item)
      return
    }
    this.currentPort = item.name;
    this.closePortList();
    this.scheduleProjectTitleLayout();
  }

  async getDevicePortList() {
    let portList0: IMenuItem[] = await this.serialService.getSerialPorts();
    if (portList0.length == 0) {
      portList0 = [
        {
          name: 'Device not found',
          text: '',
          type: 'serial',
          icon: 'fa-light fa-triangle-exclamation',
          disabled: true,
        }
      ];
    }

    if (this.platformService.supportsWebSerial()) {
      portList0.push({
        name: '选择新端口...',
        icon: 'fa-light fa-plus',
        action: 'request-web-serial-port'
      });
    } else {
      portList0.push({
        name: '当前浏览器不支持烧录',
        text: '请使用支持 Web Serial 的浏览器连接开发板',
        icon: 'fa-light fa-browser',
        disabled: true,
      });
    }
    portList0.push({ sep: true });

    if (this.projectService.isServerProject) {
      try {
        const esp32config = await this.projectService.updateEsp32ConfigMenu('');
        if (esp32config?.length) {
          portList0 = portList0.concat(esp32config);
        }
      } catch (error) {
        console.warn('获取服务端烧录配置菜单失败:', error);
      }
    } else {
      let boardConfig = this.projectService.currentBoardConfig;
      if (!boardConfig && this.projectService.isServerProject) {
        try {
          boardConfig = await this.projectService.getBoardJson();
          this.projectService.currentBoardConfig = boardConfig;
        } catch (error) {
          console.warn('获取当前开发板配置失败:', error);
        }
      }

      // 添加ESP32相关配置选项
      if (boardConfig?.['core']?.indexOf('esp32') > -1) {
        let temp = boardConfig['type'].split(':');
        let board = temp[temp.length - 1];
        let esp32config = await this.projectService.updateEsp32ConfigMenu(board);
        if (esp32config) {
          portList0 = portList0.concat(esp32config)
        }
        // console.log('ESP32配置选项:', esp32config);
      }

      // 添加STM32相关配置选项
      if (boardConfig?.['core']?.indexOf('stm32') > -1 &&
        boardConfig?.['description']?.indexOf('Series') > -1) {
        let temp = boardConfig['type'].split(':');
        let board = temp[temp.length - 1];
        // console.log('STM32开发板标识:', board);
        let stm32config = await this.projectService.updateStm32ConfigMenu(board);
        if (stm32config) {
          portList0 = portList0.concat(stm32config)
        }
        // console.log('STM32配置选项:', stm32config);
      }

      // 添加nRF5相关配置选项
      if (boardConfig?.['core']?.indexOf('nRF5') > -1) {
        let temp = boardConfig['type'].split(':');
        let board = temp[temp.length - 1];
        // console.log('nRF5开发板标识:', board);
        let nrf5config = await this.projectService.updateNrf5ConfigMenu(board);
        if (nrf5config) {
          portList0 = portList0.concat(nrf5config)
        }
        // console.log('nRF5配置选项:', nrf5config);
      }
    }

    this.configList = portList0;
    // 使用 setTimeout 将变更检测推迟到下一个变更检测周期，避免 ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => {
      this.cd.detectChanges();
    }, 0);
  }

  async requestWebSerialPort() {
    const port = await this.serialService.requestPort();
    if (port) {
      await this.getDevicePortList();
    }
  }

  onClick(item, event = null) {
    this.process(item, event);
  }

  isOpenTool(btn) {
    if (btn.data.type == 'terminal') {
      return this.terminalIsOpen;
    } else if (btn.data && btn.data.data) {
      return this.openToolList.indexOf(btn.data.data) !== -1;
    }
    return false;
  }

  onMenuClick(item) {
    if (item.disabled) return;
    this.process(item);
    this.closeMenu();
  }

  onMenuSubItemClick(item: IMenuItem): void {
    if (item.disabled) return;
    void this.process(item);
    this.closeMenu();
  }

  async process(item: IMenuItem, event = null) {
    switch (item.action) {
      case 'project-new':
        if (this.isLoaded()) { // 只在已加载项目时检查
          const canContinue = await this.checkUnsavedChanges('new');
          if (!canContinue) return;
        }
        this.uiService.openWindow(item.data);
        break;
      case 'project-list':
        if (this.isLoaded()) {
          const canContinue = await this.checkUnsavedChanges('close');
          if (!canContinue) return;
          await this.projectService.close(false);
        }
        this.router.navigate(['/main/guide']);
        break;
      case 'project-import':
        this.openImportProjectDialog();
        break;
      case 'project-save':
        this.projectService.save();
        break;
      case 'blockly-svg-export':
        this.actionService.dispatch(
          'blockly-svg-export',
          {},
          (feedback) => {
            if (feedback.success) {
              this.message.success(
                this.translate.instant('BLOCKLY_EDITOR.EXPORT_SVG_SUCCESS', {
                  fileName: feedback.data?.fileName || '',
                }),
              );
            } else {
              this.message.error(
                feedback.error ||
                this.translate.instant('BLOCKLY_EDITOR.EXPORT_SVG_FAILED'),
              );
            }
          },
          60000,
        );
        break;
      case 'project-close':
        if (this.isLoaded()) { // 只在已加载项目时检查
          const canContinue = await this.checkUnsavedChanges('close');
          if (!canContinue) return;
        }
        this.projectService.close();
        break;
      case 'tool-open':
        this.uiService.turnTool(item.data);
        break;
      // case 'terminal':
      //   this.uiService.turnTerminal(item.data);
      //   break;
      case 'compile':
        if (item.state === 'doing') return;
        item.state = 'doing';
        this.builderService.build().then(result => {
          item.state = result.state || 'done';
        }).catch(err => {
          // console.log("编译未完成: ", JSON.stringify(err));
          item.state = this.resolveActionErrorState(err, ['buildResult']);
        })
        break;
      case 'upload':
        // 确认是否选择串口
        if (!this.serialService.currentPort) {
          this.message.warning(this.translate.instant('SERIAL.SELECT_PORT_FIRST'));
          this.openPortList(event);
          return;
        }
        if (item.state === 'doing') return;
        item.state = 'doing';
        this.uploaderService.upload().then(result => {
          item.state = result.state || 'done';
        }).catch(err => {
          // console.log("上传未完成: ", JSON.stringify(err));
          item.state = this.resolveActionErrorState(err, ['result']);
        });
        break;
      case 'settings-open':
        this.uiService.openWindow({
          ...item.data,
          queryParams: { returnUrl: this.router.url }
        });
        break;
      case 'iot-development-open':
        await this.openIotPlatform();
        break;
      case 'browser-open':
        this.browserService.openUrl(item.data?.url);
        break;
      case 'user-logout':
        this.logout();
        break;
      case 'example-open':
        await this.router.navigate(['/main/playground'], {
          queryParams: { returnUrl: this.router.url }
        });
        break;
      case 'board-select':
        this.openBoardSelectorDialog();
        break;
      case 'request-web-serial-port':
        await this.requestWebSerialPort();
        break;
      default:
        console.log('未处理的操作:', item.action);
        break;
    }
  }

  private async openIotPlatform(): Promise<void> {
    const platformWindow = window.open('about:blank', '_blank');
    if (!platformWindow) {
      this.message.error('浏览器阻止了新窗口，请允许弹出窗口后重试');
      return;
    }
    platformWindow.opener = null;
    platformWindow.document.title = '正在打开 Cycore IoT…';
    platformWindow.document.body.innerHTML = '<p style="font:14px sans-serif;color:#8aa7b5;background:#030b13;margin:0;padding:32px">Cycore IoT 安全票据生成中…</p>';
    try {
      const response = await firstValueFrom(this.http.post<{ code: number; message: string; data: { ticket: string } }>(
        `${getApiBaseUrl()}/api/iot/launch-tickets`,
        {}
      ));
      if (response.code !== 200 || !response.data?.ticket) {
        throw new Error(response.message || '无法创建物联网访问票据');
      }
      const url = new URL(getIotPlatformUrl(), window.location.href);
      url.searchParams.set('ticket', response.data.ticket);
      platformWindow.location.replace(url.toString());
    } catch (error: any) {
      platformWindow.close();
      this.message.error(error?.message || '打开物联网开发平台失败');
    }
  }

  private openImportProjectDialog(): void {
    this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: { padding: '0' },
      nzWidth: '440px',
      nzContent: ProjectImportDialogComponent
    });
  }

  private resolveActionErrorState(err: any, nestedKeys: string[] = []): RunState['state'] {
    const directState = err?.state;
    if (this.isValidRunState(directState)) {
      return directState;
    }

    for (const key of nestedKeys) {
      const nestedState = err?.[key]?.state;
      if (this.isValidRunState(nestedState)) {
        return nestedState;
      }
    }

    return 'error';
  }

  private isValidRunState(state: any): state is RunState['state'] {
    return ['default', 'doing', 'done', 'error', 'warn'].includes(state);
  }

  ngOnDestroy() {
    if (this.serialPortsChangedSubscription) {
      this.serialPortsChangedSubscription.unsubscribe();
    }
    this.routeEventsSubscription?.unsubscribe();
    this.workflowStateSubscription?.unsubscribe();
    this.projectTitleResizeObserver?.disconnect();
    if (this.projectTitleLayoutFrame) {
      cancelAnimationFrame(this.projectTitleLayoutFrame);
    }
  }

  private observeProjectTitleLayout(): void {
    const header = this.headerBox?.nativeElement;
    if (!header || typeof ResizeObserver === 'undefined') {
      return;
    }

    this.projectTitleResizeObserver = new ResizeObserver(() => this.scheduleProjectTitleLayout());
    this.projectTitleResizeObserver.observe(header);
    header.querySelectorAll('.menu, .project-actions, .upload-toolbox, .serial-selector, .header-tools, .compact-tools-toolbox')
      .forEach((element) => this.projectTitleResizeObserver?.observe(element));
  }

  private scheduleProjectTitleLayout(): void {
    if (this.projectTitleLayoutFrame) {
      cancelAnimationFrame(this.projectTitleLayoutFrame);
    }

    this.projectTitleLayoutFrame = requestAnimationFrame(() => {
      this.projectTitleLayoutFrame = 0;
      this.updateProjectTitleLayout();
    });
  }

  private updateProjectTitleLayout(): void {
    const header = this.headerBox?.nativeElement;
    if (!header) {
      return;
    }

    const headerRect = header.getBoundingClientRect();
    const headerWidth = headerRect.width;
    const nextHideProjectActions = headerWidth < this.hideProjectActionsWidth;
    const nextCollapseHeaderTools = headerWidth < this.collapseHeaderToolsWidth;
    const center = headerWidth / 2;
    const leftBoundary = this.getLeftControlsBoundary(header, headerRect.left);
    const rightBoundary = this.getRightControlsBoundary(header, headerRect.left, headerWidth);
    const sideRoom = Math.min(
      center - leftBoundary - this.projectTitleSafeGap,
      rightBoundary - center - this.projectTitleSafeGap
    );
    const nextMaxWidth = Math.max(0, Math.floor(sideRoom * 2));
    const nextHidden = nextMaxWidth < this.projectTitleMinWidth;

    const compactStateChanged =
      this.hideProjectActions !== nextHideProjectActions ||
      this.collapseHeaderTools !== nextCollapseHeaderTools;

    if (
      this.projectTitleMaxWidth !== nextMaxWidth ||
      this.hideProjectTitle !== nextHidden ||
      compactStateChanged
    ) {
      this.projectTitleMaxWidth = nextMaxWidth;
      this.hideProjectTitle = nextHidden;
      this.hideProjectActions = nextHideProjectActions;
      this.collapseHeaderTools = nextCollapseHeaderTools;
      if (!nextCollapseHeaderTools) {
        this.showHeaderToolsMenu = false;
      }
      this.cd.detectChanges();
      if (compactStateChanged) {
        this.scheduleProjectTitleLayout();
      }
    }
  }

  private getLeftControlsBoundary(header: HTMLElement, headerLeft: number): number {
    return ['.menu', '.project-actions']
      .map((selector) => header.querySelector(selector))
      .filter((element): element is HTMLElement => element instanceof HTMLElement && this.isVisible(element))
      .reduce((right, element) => Math.max(right, element.getBoundingClientRect().right - headerLeft), 0);
  }

  private getRightControlsBoundary(header: HTMLElement, headerLeft: number, fallbackWidth: number): number {
    return Array.from(header.querySelectorAll('.upload-toolbox, .serial-selector, .header-tools, .compact-tools-toolbox'))
      .filter((element): element is HTMLElement => element instanceof HTMLElement && this.isVisible(element))
      .reduce((left, element) => Math.min(left, element.getBoundingClientRect().left - headerLeft), fallbackWidth);
  }

  private isVisible(element: HTMLElement): boolean {
    return element.offsetParent !== null && element.getBoundingClientRect().width > 0;
  }

  openHeaderToolsMenu(event: MouseEvent): void {
    this.headerToolsMenuPosition = this.calculateDropdownPosition(event, 220, 260);
    this.showHeaderToolsMenu = !this.showHeaderToolsMenu;
  }

  closeHeaderToolsMenu(): void {
    this.showHeaderToolsMenu = false;
  }

  async onHeaderToolsMenuClick(item: IMenuItem): Promise<void> {
    if (item.action === 'theme-toggle') {
      await this.toggleTheme();
    } else {
      await this.process(item);
    }
    this.closeHeaderToolsMenu();
    this.scheduleProjectTitleLayout();
  }

  // 快捷键功能，监听键盘事件,执行对应的操作
  private shortcutMap: Map<string, IMenuItem> = new Map();
  private initShortcutMap(): void {
    // 处理 HEADER_MENU 的快捷键
    for (const item of HEADER_MENU) {
      if (item.text) {
        // 将快捷键文本转换成标准格式(如: "ctrl+s")
        const shortcutKey = this.normalizeShortcutKey(item.text);
        if (shortcutKey) {
          this.shortcutMap.set(shortcutKey, item);
        }
      }
    }
    // 处理 HEADER_BTNS 的快捷键（编译、上传等）
    for (const item of HEADER_BTNS) {
      if (item.text) {
        const shortcutKey = this.normalizeShortcutKey(item.text);
        if (shortcutKey) {
          this.shortcutMap.set(shortcutKey, item);
        }
      }
    }
    // console.log('已初始化快捷键映射:', Array.from(this.shortcutMap.keys()));
  }

  // 转换快捷键文本为标准格式（Ctrl/⌘ 统一为 ctrl）
  private normalizeShortcutKey(shortcutText: string): string {
    if (!shortcutText) return '';

    return shortcutText.toLowerCase()
      .replace(/ctrl\/⌘|⌘/g, 'ctrl')  // Mac Command 与 Ctrl 等效
      .split('+')
      .map(part => part.trim())
      .filter(part => part)
      .sort((a, b) => {
        // 保证修饰键的顺序：ctrl 在前，shift 在后，其他按字母顺序
        if (a === 'ctrl') return -1;
        if (b === 'ctrl') return 1;
        if (a === 'shift') return -1;
        if (b === 'shift') return 1;
        return a.localeCompare(b);
      })
      .join('+');
  }

  // 从键盘事件生成标准化的快捷键字符串（Mac Command 与 Ctrl 等效）
  private getShortcutFromEvent(event: KeyboardEvent): string {
    const parts: string[] = [];

    if (event.ctrlKey || event.metaKey) parts.push('ctrl');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');

    // 添加主键，忽略修饰键本身
    const key = event.key.toLowerCase();
    if (!['control', 'shift', 'alt', 'meta'].includes(key)) {
      parts.push(key);
    }

    return parts.join('+');
  }

  /* 监听快捷键
  */
  listenShortcutKeys() {
    this.initShortcutMap();
    window.addEventListener('keydown', (event: KeyboardEvent) => {
      // 处理窗口缩放快捷键（Mac 上 Command 与 Ctrl 等效）
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
        if (event.key === '-' || event.key === '_') {
          event.preventDefault();
          this.zoomOut();
          return;
        }
        if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          this.zoomIn();
          return;
        }
        if (event.key === '0') {
          event.preventDefault();
          this.resetZoom();
          return;
        }
      }

      // 处理功能键 F1-F12
      const isFunctionKey = /^f([1-9]|1[0-2])$/i.test(event.key);

      // 处理包含修饰键的组合键或功能键（含 Mac Command）
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || isFunctionKey) {
        const shortcutKey = this.getShortcutFromEvent(event);
        const menuItem = this.shortcutMap.get(shortcutKey);

        if (menuItem && this.showInRouter(menuItem)) {
          event.preventDefault(); // 阻止默认行为
          console.log('快捷键触发:', menuItem.name, shortcutKey);

          // 执行对应的操作
          if (menuItem.action) {
            this.process(menuItem);
          }
        }
      }
    });
  }

  // 窗口缩放功能
  private currentZoomLevel = 0; // 0表示100%缩放

  zoomIn() {
    this.currentZoomLevel = Math.min(this.currentZoomLevel + 0.5, 3);
    this.setZoomLevel(this.currentZoomLevel);
  }

  zoomOut() {
    this.currentZoomLevel = Math.max(this.currentZoomLevel - 0.5, -3);
    this.setZoomLevel(this.currentZoomLevel);
  }

  resetZoom() {
    this.currentZoomLevel = 0;
    this.setZoomLevel(this.currentZoomLevel);
  }

  private setZoomLevel(level: number) {
    const zoomFactor = Math.pow(1.2, level);
    document.body.style.transform = `scale(${zoomFactor})`;
    document.body.style.transformOrigin = 'top left';
    if (zoomFactor !== 1) {
      document.body.style.width = `${100 / zoomFactor}%`;
      document.body.style.height = `${100 / zoomFactor}%`;
    } else {
      document.body.style.width = '';
      document.body.style.height = '';
    }
  }

  async checkUnsavedChanges(action: 'close' | 'open' | 'new'): Promise<boolean> {
    // 检查项目是否有未保存的更改
    if (!await this.projectService.hasUnsavedChanges()) {
      return true;
    }

    // 如果弹窗已经打开，直接返回 false，避免重复弹出
    if (this.unsaveDialogOpen) {
      return false;
    }

    return new Promise<boolean>((resolve) => {
      // 标记弹窗已打开
      this.unsaveDialogOpen = true;

      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '350px',
        nzContent: UnsaveDialogComponent,
        nzData: { action },
        // nzDraggable: true,
      });

      modalRef.afterClose.subscribe(async result => {
        // 弹窗关闭后重置标志位
        this.unsaveDialogOpen = false;

        if (!result) {
          // 用户直接关闭对话框，视为取消操作
          resolve(false);
          return;
        }
        switch (result.result) {
          case 'save':
            // 保存项目并继续
            await this.projectService.save();
            resolve(true);
            break;
          case 'continue':
            // 不保存，但继续操作
            resolve(true);
            break;
          case 'cancel':
          default:
            // 取消操作
            resolve(false);
            break;
        }
      });
    });
  }

  logout(): void {
    this.edaAuthService.logout().subscribe({
      next: () => this.finishLogout(),
      error: () => this.finishLogout(),
    });
  }

  private finishLogout(): void {
    this.edaAuthService.clearLocalSession();
    this.uiService.closeTool('user-center');
    this.closeMenu();
    this.message.success('已退出登录');
    void this.router.navigate(['/login']);
  }

  showInRouter(menuItem: IMenuItem) {
    if ((menuItem as any).id === 'lib-manager') {
      return false;
    }
    if (!menuItem.router) {
      return true;
    } else {
      for (const router of menuItem.router) {
        if (this.router.url.indexOf(router) > -1) {
          return true;
        }
      }
    }
  }

  // 判断路由是否为 ['/main/blockly-editor', '/main/code-editor']中的一个，如果是返回true
  isLoaded() {
    for (const router of ['/main/blockly-editor', '/main/code-editor']) {
      if (this.router.url.indexOf(router) > -1) {
        return true;
      }
    }
  }

  // 选择子菜单项-修改编译上传配置
  async selectSubItem(subItem: IMenuItem) {
    console.log('选择子菜单项:', subItem);
    let packageJson = await this.projectService.getPackageJson();
    packageJson['projectConfig'] = packageJson['projectConfig'] || {};

    // // 判断是否为PartitionScheme并且值为'custom'，如果是则弹出文件选择
    // if (subItem.key === 'PartitionScheme' && subItem.data.toLowerCase() === 'custom') {
    //     title: '选择分区文件',
    //     path: this.projectService.currentProjectPath,
    //   });

    //   // console.log('选中的分区文件路径：', folderPath);

    //   if (!folderPath) {
    //     this.message.warning('未选择分区文件，已取消');
    //     return;
    //   }

    // }

    packageJson['projectConfig'][subItem.key] = subItem.data;
    await this.projectService.setPackageJson(packageJson);
    // 判断是否是STM32，是则更新项目配置
    if (this.projectService.currentBoardConfig?.['core']?.indexOf('stm32') > -1 &&
      this.projectService.currentBoardConfig?.['description']?.indexOf('Series') > -1) {
      // 如果subItem包含pnum variant字段，则调用比较函数
      if (subItem.key === 'pnum' && subItem.extra?.build.variant) {
        let newPinConfig = subItem;
        this.projectService.compareStm32PinConfig(newPinConfig)
      }
    }

    // 判断是否是nRF5的softdevice选择，如果是则直接烧录softdevice
    if (this.projectService.currentBoardConfig?.['core']?.indexOf('nRF5') > -1 &&
      subItem.key === 'softdevice') {
      // 检查串口是否已选择
      if (!this.serialService.currentPort) {
        this.message.warning(this.translate.instant('NRF5.SELECT_PORT_FIRST') || '请先选择串口');
        return;
      }

      // 通过 UploaderService 调用烧录方法（使用 ActionService 分发到 _UploaderService）
      await this.uploaderService.flashSoftdevice(subItem.data, this.serialService.currentPort);
    }

    // 触发预编译操作：配置变更后自动触发预编译
    this.builderService.triggerPreprocess('config-changed');
  }

  portListPosition = { x: 40, y: 64 };
  calculatePortListPosition(event: MouseEvent) {
    this.portListPosition = this.calculateDropdownPosition(event, 260, 400);
  }

  private calculateDropdownPosition(event: MouseEvent, width: number, estimatedHeight: number) {
    const target = (event.currentTarget || event.target) as HTMLElement;
    const rect = target.getBoundingClientRect();
    return this.clampDropdownPosition(rect.left + 2, rect.bottom + 2, width, estimatedHeight);
  }

  private clampDropdownPosition(x: number, y: number, width: number, estimatedHeight: number) {
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    if (x + width > windowWidth) {
      x = windowWidth - width - 3;
    }

    if (y + estimatedHeight > windowHeight) {
      y = windowHeight - estimatedHeight - 3;
    }

    return {
      x: Math.max(3, x),
      y: Math.max(3, y)
    };
  }

  private getHeaderFallbackPosition() {
    const headerBox = document.querySelector('.header-box') as HTMLElement | null;
    const headerBottom = headerBox?.getBoundingClientRect().bottom ?? 62;
    return this.clampDropdownPosition(40, headerBottom + 2, 260, 400);
  }

  async openBoardSelectorDialog() {
    // 获取开发板列表
    let boardList = await this.configService.loadBoardList();
    console.log(boardList);

    // 显示开发板选择对话框
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzWidth: '400px',
      nzContent: BoardSelectorDialogComponent,
      nzData: {
        boardList: boardList
      }
    });

    // // 处理对话框返回结果
    // modalRef.afterClose.subscribe(result => {
    //   if (result && result.result === 'confirm') {
    //     // 开发板已经在对话框内切换完成，只需要更新UI
    //     this.cd.detectChanges();
    //   }
    // });
  }

  appStoreBtn = {
    name: 'MENU.APP_STORE',
    action: 'tool-open',
    data: { type: 'tool', data: "app-store" },
    icon: 'fa-light fa-grid-2-plus',
  }
}

export interface RunState {
  state: 'default' | 'doing' | 'done' | 'error' | 'warn';
  text: string;
}
