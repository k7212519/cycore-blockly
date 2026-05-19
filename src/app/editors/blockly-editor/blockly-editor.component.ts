import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit } from '@angular/core';
import { LibManagerComponent } from './components/lib-manager/lib-manager.component';
import { NotificationComponent } from '../../components/notification/notification.component';
import { UiService } from '../../services/ui.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ActivatedRoute } from '@angular/router';
import { ElectronService } from '../../services/electron.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { ConfigService } from '../../services/config.service';
import { NpmService } from '../../services/npm.service';
import { CmdService } from '../../services/cmd.service';
import { BlocklyService } from './services/blockly.service';
import { BlocklyComponent } from './components/blockly/blockly.component';
import { _ProjectService } from './services/project.service';
import { _UploaderService } from './services/uploader.service';
import { _BuilderService } from './services/builder.service';
import { BitmapUploadService } from './services/bitmap-upload.service';
import { ProjectService } from '../../services/project.service';
import { DevToolComponent } from './components/dev-tool/dev-tool.component';
import { OnboardingService } from '../../services/onboarding.service';
import { BLOCKLY_ONBOARDING_CONFIG } from '../../configs/onboarding.config';
import { NoticeService } from '../../services/notice.service';
import { FloatSiderComponent } from '../../components/float-sider/float-sider.component';
import { LocalLibrarySyncService } from '../../services/local-library-sync.service';
import { CodeViewerIpcService } from './services/code-viewer-ipc.service';

@Component({
  selector: 'app-blockly-editor',
  imports: [
    BlocklyComponent,
    LibManagerComponent,
    NotificationComponent,
    TranslateModule,
    DevToolComponent,
    FloatSiderComponent,
  ],
  providers: [_BuilderService, _UploaderService, BitmapUploadService],
  templateUrl: './blockly-editor.component.html',
  styleUrl: './blockly-editor.component.scss',
})
export class BlocklyEditorComponent implements OnInit, AfterViewInit, OnDestroy {
  showLibraryManager = false;
  showFloatSider = false;

  private readonly packageJsonWatchDebounceMs = 300;
  private readonly pendingLibraryLoadRetryMs = 1000;
  private readonly maxPendingLibraryLoadAttempts = 120;
  private _onMouseMoveBound = this._onMouseMove.bind(this);
  private _onMouseLeaveBound = this._onMouseLeave.bind(this);
  private packageJsonWatcherDispose: (() => void) | null = null;
  private packageJsonWatchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingLibraryLoadTimer: ReturnType<typeof setTimeout> | null = null;
  private watchedPackageJsonProjectPath: string | null = null;
  private watchedPackageJsonSignature = '';
  private watchedLibraryDependencies = new Map<string, string>();
  private pendingLibraryDependencies = new Set<string>();
  private pendingLibraryLoadAttempts = new Map<string, number>();
  private pendingLibraryLoadInProgress = false;

  devmode;

  get developerMode() {
    return this.configService.data.devmode;
  }

  constructor(
    private cd: ChangeDetectorRef,
    private uiService: UiService,
    private activatedRoute: ActivatedRoute,
    private blocklyService: BlocklyService,
    private electronService: ElectronService,
    private message: NzMessageService,
    private configService: ConfigService,
    private npmService: NpmService,
    private cmdService: CmdService,
    private projectService: ProjectService,
    private _projectService: _ProjectService,
    private _builderService: _BuilderService,
    private _uploadService: _UploaderService,
    private onboardingService: OnboardingService,
    private translate: TranslateService,
    private noticeService: NoticeService,
    private el: ElementRef,
    private ngZone: NgZone,
    private localLibrarySyncService: LocalLibrarySyncService,
    private codeViewerIpcService: CodeViewerIpcService,
  ) { }

  ngOnInit(): void {
    this.activatedRoute.queryParams.subscribe((params) => {
      if (params['path']) {
        console.log('project path', params['path']);
        try {
          this._projectService.currentProjectPath = params['path'];
          this.projectService.currentProjectPath = params['path'];
          // this._projectService.initHistory(); // 初始化历史服务
          this.loadProject(params['path']);
        } catch (error) {
          console.error('加载项目失败', error);
          this.message.error('加载项目失败，请检查项目文件是否完整');
        }
      } else {
        this.message.error('没有找到项目路径');
      }
    });

    this._projectService.init();
    this._builderService.init();
    this._uploadService.init();

    // 阻止鼠标按键前进后退
    window.history.replaceState(null, '', window.location.href);
    window.history.pushState(null, '', window.location.href);
  }

  // 用于弹出侧边栏的鼠标事件监听，放在 Zone 外避免频繁触发变更检测
  ngAfterViewInit(): void {
    // 在 Zone 外注册鼠标监听，避免每次移动都触发变更检测
    this.ngZone.runOutsideAngular(() => {
      this.el.nativeElement.addEventListener('mousemove', this._onMouseMoveBound);
      this.el.nativeElement.addEventListener('mouseleave', this._onMouseLeaveBound);
    });
  }

  private _onMouseMove(event: MouseEvent): void {
    const rect = this.el.nativeElement.getBoundingClientRect();
    const shouldShow = (rect.right - event.clientX) <= 70;
    if (shouldShow !== this.showFloatSider) {
      this.showFloatSider = shouldShow;
      this.ngZone.run(() => this.cd.markForCheck());
    }
  }

  private _onMouseLeave(): void {
    if (this.showFloatSider) {
      this.showFloatSider = false;
      this.ngZone.run(() => this.cd.markForCheck());
    }
  }

  ngOnDestroy(): void {
    this.uiService.closeTool('code-viewer');
    this.localLibrarySyncService.stop();
    this.stopPackageJsonDependencyWatch();
    this._projectService.destroy();
    this._builderService.cancel();
    this._builderService.destroy();
    this._uploadService.cancel();
    this._uploadService.destroy();
    this.codeViewerIpcService.clear();
    this.electronService.setTitle('aily blockly');
    this.blocklyService.reset();
    this.el.nativeElement.removeEventListener('mousemove', this._onMouseMoveBound);
    this.el.nativeElement.removeEventListener('mouseleave', this._onMouseLeaveBound);
  }

  async loadProject(projectPath) {
    this.stopPackageJsonDependencyWatch();
    // 处理 temp 下的 package.json：有则覆盖主项目，无则从主项目复制到 temp
    await this.projectService.syncPackageJsonWithTemp(projectPath);
    // 加载项目package.json
    const packageJson = JSON.parse(
      this.electronService.readFile(`${projectPath}/package.json`),
    );
    // 加载项目开发框架
    this.devmode = packageJson.devmode || 'arduino'; // 可选项: 'arduino', 'micropython'

    this.electronService.setTitle(`aily blockly - ${packageJson.nickname || packageJson.name}`);
    // 添加到最近打开的项目
    this.projectService.addRecentlyProject({
      name: packageJson.name,
      path: projectPath,
      nickname: packageJson.nickname || packageJson.name,
    });
    // 设置当前项目路径和package.json数据
    this._projectService.currentPackageData = packageJson;
    this.projectService.currentPackageData = packageJson;
    window['packageJson'] = packageJson;
    this.blocklyService.setToolboxSortOrder(packageJson.blocklyToolboxOrder);
    // 暴露 ProjectService 到全局，供 generator.js 使用
    window['projectService'] = this.projectService;

    if (!(await this.npmService.installedOk(projectPath))) {
      // 终端进入项目目录，安装项目依赖
      // this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('BLOCKLY_EDITOR.INSTALLING_DEPS') });
      setTimeout(() => {
        this.noticeService.update({
          title: this.translate.instant('NPM.INSTALLING_TITLE'),
          text: this.translate.instant('BLOCKLY_EDITOR.INSTALLING_DEPS'),
          state: 'doing',
          icon: 'fa-light fa-cubes',
          showProgress: false,
        });
      }, 0);
      const npmResult = await this.cmdService.runAsyncChecked(`npm install`, projectPath);
      if (!(await this.npmService.installedOk(projectPath))) {
        setTimeout(() => {
          this.noticeService.update({
            title: this.translate.instant('NPM.INSTALL_FAILED_TITLE'),
            text: this.translate.instant('NPM.BOARD_DEPS_INSTALL_FAILED'),
            detail: npmResult?.stderr || 'npm install 执行完成但依赖检查未通过',
            state: 'error',
            sendToLog: false,
          });
        }, 1000);
        return;
      }
      setTimeout(() => {
        this.noticeService.update({
          title: this.translate.instant('NPM.INSTALL_COMPLETE_TITLE'),
          text: this.translate.instant('NPM.DEPS_INSTALL_COMPLETE'),
          state: 'done',
          showProgress: false,
          setTimeout: 3000,
        });
      }, 100);
    }
    // 3. 加载开发板module中的board.json
    this.uiService.updateFooterState({
      state: 'doing',
      text: this.translate.instant('BLOCKLY_EDITOR.LOADING_BOARD_CONFIG'),
    });
    const boardJson = await this.projectService.getBoardJson();

    this.projectService.currentBoardConfig = boardJson;
    this.blocklyService.boardConfig = boardJson;
    window['boardConfig'] = boardJson;
    // 4. 加载blockly library
    this.uiService.updateFooterState({
      state: 'doing',
      text: this.translate.instant('BLOCKLY_EDITOR.LOADING_BLOCKLY_LIB'),
    });
    // 获取项目目录下的所有blockly库
    let libraryModuleList = (
      await this.npmService.getAllInstalledLibraries(projectPath)
    ).map((item) => item.name);

    await this.blocklyService.waitForWorkspace();

    for (let index = 0; index < libraryModuleList.length; index++) {
      const libPackageName = libraryModuleList[index];
      this.uiService.updateFooterState({
        state: 'doing',
        text: this.translate.instant('BLOCKLY_EDITOR.LOADING_LIB', {
          name: libPackageName,
        }),
      });
      await this.blocklyService.loadLibrary(libPackageName, projectPath);
    }
    // 5. 加载project.abi数据
    this.uiService.updateFooterState({
      state: 'doing',
      text: this.translate.instant('BLOCKLY_EDITOR.LOADING_BLOCKLY_PROGRAM'),
    });
    let jsonData = JSON.parse(
      this.electronService.readFile(`${projectPath}/project.abi`),
    );
    this.blocklyService.loadAbiJson(jsonData);

    // 6. 加载项目目录中project.abi（这是blockly格式的json文本必须要先安装库才能加载这个json，因为其中可能会用到一些库）
    this.uiService.updateFooterState({
      state: 'done',
      text: this.translate.instant('BLOCKLY_EDITOR.PROJECT_LOAD_SUCCESS'),
    });
    this.projectService.stateSubject.next('loaded');

    this.startPackageJsonDependencyWatch(projectPath);
    this.localLibrarySyncService.start(projectPath);

    // 检查是否需要显示新手引导
    this.checkBlocklyOnboarding();

    // 7. 后台安装开发板依赖
    this.npmService
      .installBoardDeps()
      .then(() => {
        console.log('install board dependencies success');
      })
      .catch((err) => {
        console.error('install board dependencies error', err);
      });
  }

  private startPackageJsonDependencyWatch(projectPath: string): void {
    this.stopPackageJsonDependencyWatch();

    const fsApi = window['fs'];
    const watch = fsApi?.watch;
    if (typeof watch !== 'function') {
      console.warn('[PackageJsonWatch] fs.watch is unavailable');
      return;
    }

    if (!this.refreshPackageJsonDependencySnapshot(projectPath)) {
      return;
    }

    this.watchedPackageJsonProjectPath = projectPath;
    this.ngZone.runOutsideAngular(() => {
      try {
        this.packageJsonWatcherDispose = watch(projectPath, (event) => {
          if (event?.eventType === 'error') {
            console.warn('[PackageJsonWatch] watch error:', event.error);
            return;
          }

          if (event?.filename && window['path']?.basename(event.filename) !== 'package.json') {
            return;
          }

          this.schedulePackageJsonDependencyCheck(projectPath);
        });
      } catch (error) {
        console.warn('[PackageJsonWatch] failed to start:', error);
        this.stopPackageJsonDependencyWatch();
      }
    });
  }

  private stopPackageJsonDependencyWatch(): void {
    if (this.packageJsonWatcherDispose) {
      try {
        this.packageJsonWatcherDispose();
      } catch (error) {
        console.warn('[PackageJsonWatch] failed to stop:', error);
      }
      this.packageJsonWatcherDispose = null;
    }

    if (this.packageJsonWatchDebounceTimer) {
      clearTimeout(this.packageJsonWatchDebounceTimer);
      this.packageJsonWatchDebounceTimer = null;
    }

    if (this.pendingLibraryLoadTimer) {
      clearTimeout(this.pendingLibraryLoadTimer);
      this.pendingLibraryLoadTimer = null;
    }

    this.watchedPackageJsonProjectPath = null;
    this.watchedPackageJsonSignature = '';
    this.watchedLibraryDependencies.clear();
    this.pendingLibraryDependencies.clear();
    this.pendingLibraryLoadAttempts.clear();
    this.pendingLibraryLoadInProgress = false;
  }

  private schedulePackageJsonDependencyCheck(projectPath: string): void {
    if (this.packageJsonWatchDebounceTimer) {
      clearTimeout(this.packageJsonWatchDebounceTimer);
    }

    this.packageJsonWatchDebounceTimer = setTimeout(() => {
      this.packageJsonWatchDebounceTimer = null;
      void this.handlePackageJsonDependencyChange(projectPath);
    }, this.packageJsonWatchDebounceMs);
  }

  private async handlePackageJsonDependencyChange(projectPath: string): Promise<void> {
    if (this.watchedPackageJsonProjectPath !== projectPath) {
      return;
    }

    let nextPackageJson: any;
    try {
      const packageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
      const nextContent = this.electronService.readFile(packageJsonPath);
      if (nextContent === this.watchedPackageJsonSignature) {
        return;
      }

      nextPackageJson = JSON.parse(nextContent);
      this.watchedPackageJsonSignature = nextContent;
    } catch (error) {
      console.warn('[PackageJsonWatch] package.json read failed:', error);
      return;
    }

    this._projectService.currentPackageData = nextPackageJson;
    this.projectService.currentPackageData = nextPackageJson;
    window['packageJson'] = nextPackageJson;

    // 对比新旧 package.json 中的 blockly library 依赖变化，找出新增和移除的库
    const previousLibraryDependencies = this.watchedLibraryDependencies;
    const nextLibraryDependencies = this.getDeclaredBlocklyLibraryDependencies(nextPackageJson);
    const addedLibraryNames = Array.from(nextLibraryDependencies.keys()).filter(
      (name) => !previousLibraryDependencies.has(name),
    ).sort((a, b) => this.compareBlocklyLibraryNames(a, b));
    const removedLibraryNames = Array.from(previousLibraryDependencies.keys()).filter(
      (name) => !nextLibraryDependencies.has(name),
    ).sort((a, b) => this.compareBlocklyLibraryNames(a, b));
    this.watchedLibraryDependencies = nextLibraryDependencies;

    if (removedLibraryNames.length > 0) {
      await this.handleRemovedLibraryDependencies(projectPath, removedLibraryNames);
    }

    if (addedLibraryNames.length === 0) {
      return;
    }

    for (const libPackageName of addedLibraryNames) {
      if (this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
        continue;
      }
      this.pendingLibraryDependencies.add(libPackageName);
      if (!this.pendingLibraryLoadAttempts.has(libPackageName)) {
        this.pendingLibraryLoadAttempts.set(libPackageName, 0);
      }
    }

    this.schedulePendingLibraryLoad(projectPath, 0);
  }

  private async handleRemovedLibraryDependencies(projectPath: string, removedLibraryNames: string[]): Promise<void> {
    for (const libPackageName of removedLibraryNames) {
      this.clearPendingLibrary(libPackageName);

      if (!this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
        continue;
      }

      if (this.blocklyService.isLibraryPackageNameUsedByCurrentProject(libPackageName)) {
        console.warn('[PackageJsonWatch] library dependency removed but still used:', libPackageName);
        this.message.warning(`${libPackageName} 已从 package.json 移除，但项目中仍有相关积木`, { nzDuration: 5000 });
        continue;
      }

      await this.blocklyService.unloadLibrary(libPackageName, projectPath);
    }
  }

  private refreshPackageJsonDependencySnapshot(projectPath: string): boolean {
    try {
      const packageJsonPath = this.electronService.pathJoin(projectPath, 'package.json');
      const content = this.electronService.readFile(packageJsonPath);
      const packageJson = JSON.parse(content);
      this.watchedPackageJsonSignature = content;
      this.watchedLibraryDependencies = this.getDeclaredBlocklyLibraryDependencies(packageJson);
      return true;
    } catch (error) {
      console.warn('[PackageJsonWatch] failed to snapshot package.json:', error);
      return false;
    }
  }

  private getDeclaredBlocklyLibraryDependencies(packageJson: any): Map<string, string> {
    const dependencies = {
      ...(packageJson?.dependencies || {}),
      ...(packageJson?.devDependencies || {}),
    };

    const libraryDependencies = new Map<string, string>();
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof name === 'string' && name.startsWith('@aily-project/lib-')) {
        libraryDependencies.set(name, String(version ?? ''));
      }
    }

    return libraryDependencies;
  }

  private schedulePendingLibraryLoad(projectPath: string, delayMs: number): void {
    if (this.pendingLibraryLoadTimer) {
      clearTimeout(this.pendingLibraryLoadTimer);
    }

    this.pendingLibraryLoadTimer = setTimeout(() => {
      this.pendingLibraryLoadTimer = null;
      void this.loadPendingLibraries(projectPath);
    }, delayMs);
  }

  private async loadPendingLibraries(projectPath: string): Promise<void> {
    if (this.pendingLibraryLoadInProgress || this.pendingLibraryDependencies.size === 0) {
      return;
    }

    if (this.watchedPackageJsonProjectPath !== projectPath) {
      return;
    }

    this.pendingLibraryLoadInProgress = true;
    let shouldLoadInstalledLibraries = false;
    try {
      const pendingLibraryNames = Array.from(this.pendingLibraryDependencies).sort((a, b) =>
        this.compareBlocklyLibraryNames(a, b),
      );
      for (const libPackageName of pendingLibraryNames) {
        if (this.watchedPackageJsonProjectPath !== projectPath) {
          return;
        }

        if (this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
          shouldLoadInstalledLibraries = true;
          this.clearPendingLibrary(libPackageName);
          continue;
        }

        if (this.isBlocklyLibraryPackageReady(projectPath, libPackageName)) {
          await this.blocklyService.loadLibrary(libPackageName, projectPath);
          if (this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
            shouldLoadInstalledLibraries = true;
            this.clearPendingLibrary(libPackageName);
            continue;
          }
        }

        const attempts = (this.pendingLibraryLoadAttempts.get(libPackageName) || 0) + 1;
        if (attempts >= this.maxPendingLibraryLoadAttempts) {
          console.warn('[PackageJsonWatch] library dependency was not ready:', libPackageName);
          this.clearPendingLibrary(libPackageName);
        } else {
          this.pendingLibraryLoadAttempts.set(libPackageName, attempts);
        }
      }
    } finally {
      this.pendingLibraryLoadInProgress = false;
    }

    if (shouldLoadInstalledLibraries && this.watchedPackageJsonProjectPath === projectPath) {
      await this.loadInstalledBlocklyLibraries(projectPath);
    }

    if (this.pendingLibraryDependencies.size > 0 && this.watchedPackageJsonProjectPath === projectPath) {
      this.schedulePendingLibraryLoad(projectPath, this.pendingLibraryLoadRetryMs);
    }
  }

  private async loadInstalledBlocklyLibraries(projectPath: string): Promise<void> {
    try {
      const installedLibraries = await this.npmService.getAllInstalledLibraries(projectPath);
      for (const lib of installedLibraries) {
        const libPackageName = lib?.name;
        if (typeof libPackageName !== 'string') {
          continue;
        }
        if (this.isBlocklyLibraryLoaded(projectPath, libPackageName)) {
          continue;
        }
        if (!this.isBlocklyLibraryPackageReady(projectPath, libPackageName)) {
          continue;
        }

        await this.blocklyService.loadLibrary(libPackageName, projectPath);
      }
    } catch (error) {
      console.warn('[PackageJsonWatch] failed to load installed Blockly libraries:', error);
    }
  }

  private clearPendingLibrary(libPackageName: string): void {
    this.pendingLibraryDependencies.delete(libPackageName);
    this.pendingLibraryLoadAttempts.delete(libPackageName);
  }

  private compareBlocklyLibraryNames(a: string, b: string): number {
    const aIsCore = a.startsWith('@aily-project/lib-core-');
    const bIsCore = b.startsWith('@aily-project/lib-core-');
    if (aIsCore && !bIsCore) {
      return -1;
    }
    if (!aIsCore && bIsCore) {
      return 1;
    }
    return a.localeCompare(b);
  }

  private isBlocklyLibraryLoaded(projectPath: string, libPackageName: string): boolean {
    return this.blocklyService.loadedLibraries.has(
      this.getBlocklyLibraryPackagePath(projectPath, libPackageName),
    );
  }

  private isBlocklyLibraryPackageReady(projectPath: string, libPackageName: string): boolean {
    const libPackagePath = this.getBlocklyLibraryPackagePath(projectPath, libPackageName);
    return ['package.json', 'block.json', 'toolbox.json', 'generator.js'].every((fileName) =>
      this.electronService.exists(this.electronService.pathJoin(libPackagePath, fileName)),
    );
  }

  private getBlocklyLibraryPackagePath(projectPath: string, libPackageName: string): string {
    return this.electronService.pathJoin(projectPath, 'node_modules', ...libPackageName.split('/'));
  }

  openProjectManager(event?: MouseEvent) {
    if (this.blocklyService.checkAiWaiting()) {
      return;
    }
    // hideChaff 会关闭所有打开的下拉、输入、WidgetDiv 和 DropDownDiv
    this.blocklyService.workspace.hideChaff();
    // this.uiService.closeToolAll();
    this.showLibraryManager = !this.showLibraryManager;
    this.cd.detectChanges();
  }

  // 检查是否需要显示新手引导
  private checkBlocklyOnboarding() {
    const hasSeenOnboarding =
      this.configService.data.blocklyOnboardingCompleted;
    if (!hasSeenOnboarding) {
      // 延迟显示引导，确保 Blockly 工作区已完全渲染
      setTimeout(() => {
        this.onboardingService.start(BLOCKLY_ONBOARDING_CONFIG, {
          onClosed: () => this.onOnboardingClosed(),
          onCompleted: () => this.onOnboardingClosed(),
        });
      }, 500);
    }
  }

  // 引导关闭或完成时的处理
  private onOnboardingClosed() {
    this.configService.data.blocklyOnboardingCompleted = true;
    this.configService.save();
  }

  // 测试用
  reload() {
    this.projectService.projectOpen();
  }

}
