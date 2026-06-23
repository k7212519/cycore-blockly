import { ChangeDetectorRef, Component, EventEmitter, Input, OnDestroy, Output } from '@angular/core';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { NzMessageService } from 'ng-zorro-antd/message';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzPaginationModule } from 'ng-zorro-antd/pagination';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NpmService } from '../../../../services/npm.service';
import { ConfigService } from '../../../../services/config.service';
import { ProjectService } from '../../../../services/project.service';
import { NzModalService } from 'ng-zorro-antd/modal';
import { CompatibleDialogComponent } from '../compatible-dialog/compatible-dialog.component';
import { CmdOutput, CmdService } from '../../../../services/cmd.service';
import { BrowserService } from '../../../../services/browser.service';
import { BlocklyService } from '../../services/blockly.service';
import { PlatformService } from '../../../../services/platform.service';
import { WorkflowService } from '../../../../services/workflow.service';
import { CrossPlatformCmdService } from '../../../../services/cross-platform-cmd.service';
import {
  catchError,
  debounceTime,
  forkJoin,
  from,
  map,
  Observable,
  of,
  Subject,
  switchMap,
  takeUntil,
  tap
} from 'rxjs';

@Component({
  selector: 'app-lib-manager',
  imports: [
    FormsModule,
    CommonModule,
    NzInputModule,
    NzButtonModule,
    NzToolTipModule,
    NzSelectModule,
    NzTagModule,
    NzPaginationModule,
    TranslateModule
  ],
  templateUrl: './lib-manager.component.html',
  styleUrl: './lib-manager.component.scss'
})
export class LibManagerComponent implements OnDestroy {

  @Input() professionalMode = false;
  @Output() close = new EventEmitter();
  @Output() librariesChanged = new EventEmitter<void>();

  keyword: string = '';
  tagList: string[] = [];
  libraryList: PackageInfo[] = [];
  _libraryList: PackageInfo[] = [];
  installedPackageList: string[] = [];
  tagListRandom;

  loading = false;
  listLoading = false;
  listError = '';
  pageIndex = 1;
  pageSize = 24;
  total = 0;
  private readonly searchInput$ = new Subject<string>();
  private readonly serverLoadRequests$ = new Subject<ServerLibraryLoadRequest>();
  private readonly destroy$ = new Subject<void>();
  private lastDebouncedKeyword: string | null = null;
  private lastInstalledLibraries: any[] = [];

  constructor(
    private npmService: NpmService,
    private configService: ConfigService,
    public projectService: ProjectService,
    private blocklyService: BlocklyService,
    private message: NzMessageService,
    private cd: ChangeDetectorRef,
    private translate: TranslateService,
    private modal: NzModalService,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private browserService: BrowserService,
    private platformService: PlatformService,
    private workflowService: WorkflowService
  ) {
  }

  async ngOnInit() {
    // 使用翻译初始化标签列表
    this.tagList = [
      this.translate.instant('LIB_MANAGER.SENSORS'),
      this.translate.instant('LIB_MANAGER.ACTUATORS'),
      this.translate.instant('LIB_MANAGER.COMMUNICATION'),
      this.translate.instant('LIB_MANAGER.DISPLAY'),
      this.translate.instant('LIB_MANAGER.STORAGE'),
      this.translate.instant('LIB_MANAGER.AI'),
      this.translate.instant('LIB_MANAGER.IOT'),
    ];

    this.setupSearchLoading();
    if (this.projectService.isServerProject) {
      this.requestServerLibraryPage();
    } else {
      this._libraryList = this.process(this.configService.libraryList || []);
      this.libraryList = this.applyLocalization(await this.checkInstalled());
      this.cd.detectChanges();
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  async checkInstalled(libraryList = null, installedLibrariesInput: any[] | null = null) {
    let isNull = false;
    if (libraryList === null) {
      isNull = true;
      libraryList = JSON.parse(JSON.stringify(this._libraryList));
    }
    // 获取已经安装的包，用于在界面上显示"移除"按钮
    const installedLibraries = installedLibrariesInput
      || await this.loadInstalledLibraries();
    return this.mergeInstalledLibraries(libraryList, installedLibraries, isNull);
  }

  private async loadInstalledLibraries(): Promise<any[]> {
    try {
      const libraries = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
      this.lastInstalledLibraries = Array.isArray(libraries) ? libraries.map(item => ({ ...item })) : [];
      return this.lastInstalledLibraries.map(item => ({ ...item }));
    } catch (error) {
      console.warn('[LibManager] 加载已安装库失败，使用上一次缓存作为降级结果', error);
      return this.lastInstalledLibraries.map(item => ({ ...item }));
    }
  }

  private mergeInstalledLibraries(libraryList: any[], installedLibrariesInput: any[], includeMissing: boolean) {
    const installedLibraries = installedLibrariesInput.map(item => {
      item = { ...item };
      item['state'] = 'installed';
      item['fulltext'] = `installed${item.name}${item.nickname}${item.keywords}${item.description}${item.brand}`.replace(/\s/g, '').toLowerCase();
      return item;
    });

    // console.log('所有库列表：', libraryList);
    // console.log('已安装的库列表：', installedLibraries);
    // 遍历installedLibraries, 如果this.libraryList存在name相同的库，则将installedLibraries中的库合并到this.libraryList中
    libraryList.forEach(lib => {
      const installedLib = installedLibraries.find(installed => installed.name === lib.name);
      if (installedLib) {
        Object.assign(lib, installedLib);
      } else {
        lib.state = 'default'; // 如果没有安装，则设置状态为默认
      }
    });

    // 将只存在于installedLibraries中但不在libraryList中的库添加到libraryList中
    if (includeMissing) {
      installedLibraries.forEach(installedLib => {
        const existsInLibraryList = libraryList.find(lib => lib.name === installedLib.name);
        if (!existsInLibraryList) {
          // 为新添加的库设置默认属性
          installedLib['versionList'] = [installedLib.version];
          libraryList.push(installedLib);
        }
      });
    }

    // console.log('合并后的库列表：', libraryList);
    return libraryList;
  }

  // 处理库列表数据，为显示做准备
  process(array) {
    for (let index = 0; index < array.length; index++) {
      const item = array[index];
      // 为版本选择做准备
      item['versionList'] = [item.version];
      // 为状态做准备
      item['state'] = 'default'; // default, installed, installing, uninstalling
      // 为全文搜索做准备
      item['fulltext'] = `${item.name || ''}${item.nickname || ''}${JSON.stringify(item.keywords || [])}${item.description || ''}${item.brand || ''}${JSON.stringify(item.tags || [])}`.replace(/\s/g, '').toLowerCase();
    }
    return array;
  }

  onSearchInput() {
    this.searchInput$.next(this.keyword || '');
  }

  async search(keyword = this.keyword) {
    this.keyword = keyword;
    this.pageIndex = 1;
    this.lastDebouncedKeyword = null;
    if (this.projectService.isServerProject) {
      this.requestServerLibraryPage();
      return;
    }
    await this.applyLocalSearch(keyword);
  }

  private async applyLocalSearch(keyword = this.keyword) {
    if (keyword) {
      keyword = keyword.replace(/\s/g, '').toLowerCase();

      if (keyword === 'ai') {
        keyword = 'artificialintelligence';
      }

      // 使用indexOf过滤并记录关键词位置，然后按位置排序
      let libraryList = await this.checkInstalled();
      const matchedItems = libraryList
        .map(item => {
          const index = item.fulltext.indexOf(keyword);
          return { item, index };
        })
        .filter(({ index }) => index !== -1)
        .sort((a, b) => a.index - b.index)
        .map(({ item }) => item);

      this.libraryList = this.applyLocalization(matchedItems);
    } else {
      this.libraryList = this.applyLocalization(await this.checkInstalled());
    }
  }

  async onPageChange(pageIndex: number) {
    this.pageIndex = pageIndex;
    if (this.projectService.isServerProject) {
      this.requestServerLibraryPage();
    }
  }

  private setupSearchLoading() {
    this.searchInput$.pipe(
      debounceTime(300),
      takeUntil(this.destroy$)
    ).subscribe(keyword => {
      if (keyword === this.lastDebouncedKeyword) {
        return;
      }
      this.lastDebouncedKeyword = keyword;
      this.pageIndex = 1;
      if (this.projectService.isServerProject) {
        this.requestServerLibraryPage(keyword);
      } else {
        void this.applyLocalSearch(keyword);
      }
    });

    this.serverLoadRequests$.pipe(
      tap(() => {
        this.listLoading = true;
      }),
      switchMap(request => this.fetchServerLibraryView(request).pipe(
        map(result => ({ result, error: null })),
        catchError(error => of({ result: null, error }))
      )),
      takeUntil(this.destroy$)
    ).subscribe(({ result, error }) => {
      this.listLoading = false;
      if (error || !result) {
        this.listError = this.readableLoadError(error);
        this.libraryList = [];
        this.total = 0;
        this.message.error(this.listError);
        this.cd.detectChanges();
        return;
      }
      this.listError = '';
      this.total = result.total;
      this.pageIndex = result.page;
      this.pageSize = result.pageSize;
      this._libraryList = result.records;
      this.libraryList = this.applyLocalization(result.records);
      this.cd.detectChanges();
    });
  }

  private requestServerLibraryPage(keyword = this.keyword) {
    this.keyword = keyword || '';
    this.serverLoadRequests$.next({
      keyword: this.keyword,
      pageIndex: this.pageIndex,
      pageSize: this.pageSize,
      lang: this.translate.currentLang || ''
    });
  }

  private fetchServerLibraryView(request: ServerLibraryLoadRequest): Observable<ServerLibraryView> {
    const normalizedKeyword = request.keyword.replace(/\s/g, '').toLowerCase();
    const installedLibraries$ = from(this.loadInstalledLibraries());
    if (normalizedKeyword === 'installed') {
      return installedLibraries$.pipe(
        map(installedLibraries => {
          const records = this.process(installedLibraries || []);
          return {
            records: this.mergeInstalledLibraries(records, installedLibraries, false),
            total: records.length,
            page: 1,
            pageSize: request.pageSize
          };
        })
      );
    }

    return forkJoin({
      page: this.projectService.loadServerLibraries$(
        request.keyword,
        request.pageIndex,
        request.pageSize,
        request.lang
      ),
      installedLibraries: installedLibraries$
    }).pipe(
      map(({ page, installedLibraries }) => {
        const records = this.process(page?.records || []);
        return {
          records: this.mergeInstalledLibraries(records, installedLibraries, false),
          total: page?.total || 0,
          page: page?.page || request.pageIndex,
          pageSize: page?.pageSize || request.pageSize
        };
      })
    );
  }

  emptyStateTitle() {
    if (this.listError) {
      return this.listError;
    }
    const lang = this.translate.currentLang || this.translate.defaultLang || '';
    return lang.toLowerCase().startsWith('en') ? 'No libraries found' : '暂无可显示的库';
  }

  private readableLoadError(error: any): string {
    const status = error?.status;
    if (status === 401 || error?.message === '缺少认证令牌') {
      return '登录状态已失效，请重新登录后再试';
    }
    return error?.message || '扩展库列表加载失败';
  }

  back() {
    this.close.emit();
  }

  async getVerisons(lib) {
    this.loading = true;
    lib.versionList = this.npmService.getPackageVersionList(lib.name);
    this.loading = false;
  }

  currentStreamId;
  output = '';
  isInstalling = false;

  private removeTaskMessage(taskMessage?: { messageId?: string }) {
    if (taskMessage?.messageId) {
      this.message.remove(taskMessage.messageId);
    }
  }

  async installLib(lib) {
    // 检查库兼容性
    // console.log('当前开发板内核：', this.projectService.currentBoardConfig.core.replace('aily:', ''));
    // console.log('当前库兼容内核：', JSON.stringify(lib.compatibility.core));
    // if (!await this.checkCompatibility(lib.compatibility.core, this.projectService.currentBoardConfig.core.replace('aily:', ''))) {
    //   return;
    // }
    // 处理 core 字符串，去掉第一个以 ':' 分割的部分
    const boardCore = (this.projectService.currentBoardConfig?.core || '').split(':').slice(1).join(':');
    if (!await this.checkCompatibility(lib.compatibility?.core, boardCore)) {
      return;
    }
    // console.log('当前项目路径：', this.projectService.currentProjectPath);
    this.isInstalling = true;
    this.workflowService.startInstall();
    let packageList_old = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
    // console.log('当前已安装的库列表：', packageList_old);

    this.output = '';
    try {
      if (this.projectService.isServerProject) {
        const installedLibraries = await this.projectService.installServerProjectLibrary(lib.name);
        this.lastInstalledLibraries = installedLibraries.map(item => ({ ...item }));
        this.libraryList = this.applyLocalization(this.mergeInstalledLibraries(this.libraryList, installedLibraries, false));
        this.message.success(`${lib._nickname || lib.nickname} ${this.translate.instant('LIB_MANAGER.INSTALLED')}`);
        let packageList_new = installedLibraries;
        const newPackages = packageList_new.filter(pkg => !packageList_old.some(oldPkg => oldPkg.name === pkg.name && oldPkg.version === pkg.version));
        if (!this.professionalMode) {
          for (const pkg of newPackages) {
            await this.blocklyService.loadLibrary(pkg.name, this.projectService.currentProjectPath);
          }
        }
        this.librariesChanged.emit();
        this.isInstalling = false;
        this.workflowService.finishInstall(true);
        return;
      }

      const { code } = await this.cmdService.runAsync(`npm install ${lib.name}@${lib.version}`, this.projectService.currentProjectPath);

      if (code !== 0) {
        throw new Error();
      }

      this.libraryList = this.applyLocalization(await this.checkInstalled(this.libraryList));
      // lib.state = 'default';
      this.message.success(`${lib._nickname || lib.nickname} ${this.translate.instant('LIB_MANAGER.INSTALLED')}`);

      let packageList_new = await this.npmService.getAllInstalledLibraries(this.projectService.currentProjectPath);
      // console.log('新的已安装的库列表：', packageList_new);
      // 比对相较于旧的已安装库列表，找出新增的库
      const newPackages = packageList_new.filter(pkg => !packageList_old.some(oldPkg => oldPkg.name === pkg.name && oldPkg.version === pkg.version));
      // console.log('新增的库：', newPackages);
      for (const pkg of newPackages) {
        this.blocklyService.loadLibrary(pkg.name, this.projectService.currentProjectPath);
      }
      this.isInstalling = false;
      this.workflowService.finishInstall(true);
    } catch (error) {
      this.isInstalling = false;
      lib.state = 'error'; // Or revert to previous state
      this.message.error(`${lib._nickname || lib.nickname} ${this.translate.instant('LIB_MANAGER.INSTALL_FAILED')}`);
      this.workflowService.finishInstall(false, error.message || 'Install failed');
    }
  }

  async removeLib(lib) {
    // 移除库前，应先检查项目代码是否使用了该库，如果使用了，应提示用户
    if (!this.professionalMode && await this.checkLibUsage(lib)) {
      this.message.warning(this.translate.instant('LIB_MANAGER.LIB_IN_USE'), { nzDuration: 5000 });
      return;
    }
    this.isInstalling = true;
    if (this.projectService.isServerProject) {
      try {
        if (!this.professionalMode) {
          await this.blocklyService.removeServerLibrary(lib.name);
        }
        const installedLibraries = await this.projectService.removeServerProjectLibrary(lib.name);
        this.lastInstalledLibraries = installedLibraries.map(item => ({ ...item }));
        this.libraryList = this.applyLocalization(this.mergeInstalledLibraries(this.libraryList, installedLibraries, false));
        this.librariesChanged.emit();
        this.message.success(`${lib._nickname || lib.nickname} ${this.translate.instant('LIB_MANAGER.UNINSTALLED')}`);
      } catch (error: any) {
        lib.state = 'error';
        this.message.error(`${lib._nickname || lib.nickname} 卸载失败: ${error?.message || error}`);
      } finally {
        this.isInstalling = false;
      }
      return;
    }

    // 使用pathJoin处理路径，正确处理包含'/'的包名（如@aily-project/test）
    const libPackagePath = this.browserService.pathJoin(
      this.projectService.currentProjectPath,
      'node_modules',
      ...lib.name.split('/')
    );
    try {
      this.blocklyService.removeLibrary(libPackagePath);
      this.output = '';
      await this.cmdService.runAsync(`npm uninstall ${lib.name}`, this.projectService.currentProjectPath);
      this.libraryList = this.applyLocalization(await this.checkInstalled(this.libraryList));
      // lib.state = 'default';
      this.message.success(`${lib._nickname || lib.nickname} ${this.translate.instant('LIB_MANAGER.UNINSTALLED')}`);
    } catch (error: any) {
      lib.state = 'error';
      this.message.error(`${lib._nickname || lib.nickname} 卸载失败: ${error?.message || error}`);
    } finally {
      this.isInstalling = false;
    }
  }


  async checkLibUsage(lib) {
    // 检查项目代码是否使用了该库
    let blocksData: any[] = [];
    if (this.projectService.isServerProject) {
      try {
        blocksData = JSON.parse(await this.projectService.readServerFile(`node_modules/${lib.name}/block.json`));
      } catch {
        return false;
      }
    } else {
    const separator = this.platformService.getPlatformSeparator();
    const libPackagePath = this.projectService.currentProjectPath + `${separator}node_modules${separator}` + lib.name;
    const libBlockPath = libPackagePath + `${separator}block.json`;
      blocksData = JSON.parse(this.browserService.readFile(libBlockPath));
    }
    const abiJson = JSON.stringify(this.blocklyService.getWorkspaceJson());
    for (let index = 0; index < blocksData.length; index++) {
      const element = blocksData[index];
      if (abiJson.includes(element.type)) {
        return true;
      }
    }
    return false;
  }

  async checkCompatibility(libCompatibility, boardCore): Promise<boolean> {
    // 检查项目是否有未保存的更改
    if (!libCompatibility || libCompatibility.length == 0 || libCompatibility.includes(boardCore)) {
      return true;
    }
    // 遍历libCompatibility，判断每个元素是否包含boardCore
    for (let i = 0; i < libCompatibility.length; i++) {
      const element = libCompatibility[i];
      if (element.includes(boardCore)) {
        return true;
      }
    }

    return new Promise<boolean>((resolve) => {
      const modalRef = this.modal.create({
        nzTitle: null,
        nzFooter: null,
        nzClosable: false,
        nzBodyStyle: {
          padding: '0',
        },
        nzWidth: '360px',
        nzContent: CompatibleDialogComponent,
        nzData: { libCompatibility, boardCore },
        // nzDraggable: true,
      });

      modalRef.afterClose.subscribe(async result => {
        if (!result) {
          // 用户直接关闭对话框，视为取消操作
          resolve(false);
          return;
        }
        switch (result.result) {
          case 'continue':
            resolve(true);
            break;
          case 'cancel':
            resolve(false);
            break;
          default:
            resolve(false);
            break;
        }
      });
    });
  }

  private applyLocalization(list: any[]) {
    const lang = this.translate.currentLang;
    for (const lib of list) {
      lib._nickname = (lang && lib[`nickname_${lang}`]) || lib.nickname || '';
      lib._description = (lang && lib[`description_${lang}`]) || lib.description || '';
    }
    return list;
  }

  openExample(packageName) {
    this.browserService.openNewInStance('/main/playground/s/' + packageName.replace('@aily-project/', ''))
  }

  private getImportedLibraryBasePath() {
    return this.browserService.pathJoin(this.projectService.currentProjectPath, 'local-libraries');
  }

  private resolveImportedLibraryPath(packageName: string) {
    return this.browserService.pathJoin(this.getImportedLibraryBasePath(), ...packageName.split('/'));
  }

  private async copyLibraryToProject(folderPath: string) {
    const packageJsonPath = this.browserService.pathJoin(folderPath, 'package.json');
    const packageJson = JSON.parse(this.browserService.readFile(packageJsonPath));
    const packageName = packageJson?.name;

    if (!packageName) {
      throw new Error('package.json 缺少 name 字段');
    }

    const importedLibraryPath = this.resolveImportedLibraryPath(packageName);
    const importedLibraryParentPath = this.browserService.pathJoin(importedLibraryPath, '..');

    await this.crossPlatformCmdService.createDirectory(importedLibraryParentPath, true);

    if (folderPath !== importedLibraryPath && this.browserService.exists(importedLibraryPath)) {
      await this.crossPlatformCmdService.removeItem(importedLibraryPath, true, true);
    }

    if (folderPath !== importedLibraryPath) {
      await this.crossPlatformCmdService.copyItem(folderPath, importedLibraryPath, true, true);
    }

    return importedLibraryPath;
  }

  openUrl(url: string) {
    this.browserService.openUrl(url);
  }
}

interface ServerLibraryLoadRequest {
  keyword: string;
  pageIndex: number;
  pageSize: number;
  lang: string;
}

interface ServerLibraryView {
  records: PackageInfo[];
  total: number;
  page: number;
  pageSize: number;
}

interface PackageInfo {
  "name": string,
  "nickname": string,
  "scope"?: string,
  "description"?: string,
  "version"?: string,
  "versionList"?: string[],
  "keywords"?: string[],
  "date"?: string,
  "author"?: {
    "name"?: string
  },
  icon?: string,
  "publisher"?: any,
  "maintainers"?: any[],
  "links"?: any,
  "brand"?: string,
  "fulltext"?: string,
  url?: string,
  tested: boolean,
  state: 'default' | 'installed' | 'installing' | 'uninstalling',
  example?: string,
  _nickname?: string,
  _description?: string,
  [key: string]: any
}
