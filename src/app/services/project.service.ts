import { Injectable } from '@angular/core';
import { BehaviorSubject, firstValueFrom, Observable, Subject } from 'rxjs';
import { map as rxMap } from 'rxjs/operators';
import { HttpClient } from '@angular/common/http';
import { UiService } from './ui.service';
import { BrowserService } from './browser.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { pinyin } from "pinyin-pro";
import { Router } from '@angular/router';
import { CmdService } from './cmd.service';
import { CrossPlatformCmdService } from './cross-platform-cmd.service';
import { generateDateString } from '../func/func';
import { ConfigService } from './config.service';
import { ESP32_CONFIG_MENU } from '../configs/esp32.config';
import { STM32_CONFIG_MENU } from '../configs/stm32.config';
import { NRF5_CONFIG_MENU } from '../configs/nrf5.config';
import { ActionService } from './action.service';
import { PlatformService } from './platform.service';
import { NewProjectData } from '../pages/project-new/project-new.component';
import { WorkflowService } from './workflow.service';
import { TranslateService } from '@ngx-translate/core';
import { NoticeService } from './notice.service';
import { API } from '../configs/api.config';

interface ProjectPackageData {
  name: string;
  nickname?: string;
  version?: string;
  author?: string;
  description?: string;
  path?: string;
  board?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  type?: string;
  framework?: string;
  cloudId?: string; // 云端项目ID
}

interface ApiResult<T> {
  code: number;
  message: string;
  data: T;
}

export interface ServerBoardInfo {
  name: string;
  nickname: string;
  version: string;
  img?: string;
  description?: string;
  url?: string;
  brand?: string;
  type?: string;
  mode?: string[];
  state?: string;
  boardDirectory?: string;
}

export interface ServerProjectInfo {
  projectId: string;
  name: string;
  editor: 'blockly' | 'code' | string;
  packageJson: any;
}

export interface ServerProjectListItem {
  projectId: string;
  name: string;
  packageName?: string;
  boardName?: string;
  boardNickname?: string;
  editor: 'blockly' | 'code' | string;
  status?: string;
  createTime?: string;
  updateTime?: string;
}

export interface ServerFileNode {
  name: string;
  path: string;
  directory: boolean;
  children?: ServerFileNode[];
}

export interface ServerCompileResult {
  success: boolean;
  text: string;
  fullStdOut: string;
  fullStdErr: string;
  artifactPath?: string;
  artifactId?: string;
  flashFiles?: ServerFlashFile[];
}

export interface ServerFlashFile {
  address: number;
  fileName: string;
  url: string;
  size?: number;
}

export interface ServerProjectUploadOptions {
  menuItems: any[];
}

export interface ServerProjectLibraries {
  libraries: any[];
}

export interface ServerLibraryListItem {
  name: string;
  nickname: string;
  description: string;
  version: string;
  author?: string;
  brand?: string;
  keywords?: string[];
  tags?: string[];
  compatibility?: Record<string, any>;
  icon?: string;
  url?: string;
  tested?: boolean;
  example?: string;
  sourceExists?: boolean;
  archiveExists?: boolean;
}

export interface ServerLibraryPage<T = ServerLibraryListItem> {
  records: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ServerBlocklyLibraryResource {
  name: string;
  blockJson?: string | null;
  toolboxJson?: string | null;
  generatorJs?: string | null;
  i18nJson?: string | null;
  missingFiles?: string[];
}

export interface ServerBlocklyLibraryResources {
  libraries: ServerBlocklyLibraryResource[];
}

export interface ServerProjectPage<T> {
  records: T[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable({
  providedIn: 'root',
})
export class ProjectService {

  stateSubject = new BehaviorSubject<'default' | 'loading' | 'loaded' | 'saving' | 'saved' | 'error'>('default');

  // 开发板变更事件通知，只在变更时发出
  boardChangeSubject = new Subject<void>();

  // 当前项目路径的订阅源
  private currentProjectPathSubject = new BehaviorSubject<string>('');
  currentProjectPath$ = this.currentProjectPathSubject.asObservable();
  private currentProjectIdSubject = new BehaviorSubject<string>('');
  currentProjectId$ = this.currentProjectIdSubject.asObservable();
  private readonly serverProjectLibrariesCache = new Map<string, any[]>();
  private readonly serverProjectLibrariesInFlight = new Map<string, Promise<any[]>>();
  private readonly serverBlocklyResourceCache = new Map<string, ServerBlocklyLibraryResource>();

  currentPackageData: ProjectPackageData = {
    name: 'Cycore MCU DevCloud',
  };
  lastServerCompileResult: ServerCompileResult | null = null;

  projectRootPath: string;

  // 当前项目路径的 getter 和 setter
  get currentProjectPath(): string {
    return this.currentProjectPathSubject.value;
  }

  set currentProjectPath(path: string) {
    this.currentProjectPathSubject.next(path);
  }

  get currentProjectId(): string {
    return this.currentProjectIdSubject.value;
  }

  set currentProjectId(projectId: string) {
    this.currentProjectIdSubject.next(projectId || '');
    if (projectId) {
      this.currentProjectPathSubject.next(this.serverProjectPath(projectId));
    }
  }

  get isServerProject(): boolean {
    return !!this.currentProjectId;
  }

  serverProjectPath(projectId = this.currentProjectId): string {
    return projectId ? `server-project:${projectId}` : '';
  }
  currentBoardConfig: any;
  // STM32选择开发板时定义引脚使用
  currentStm32Config: { board: any, variant: any, variant_h: any } = { board: null, variant: null, variant_h: null };

  constructor(
    private uiService: UiService,
    private browserService: BrowserService,
    private message: NzMessageService,
    private router: Router,
    private cmdService: CmdService,
    private crossPlatformCmdService: CrossPlatformCmdService,
    private configService: ConfigService,
    private actionService: ActionService,
    private platformService: PlatformService,
    private workflowService: WorkflowService,
    private translate: TranslateService,
    private noticeService: NoticeService,
    private http: HttpClient
  ) {
  }

  // 初始化UI服务，这个init函数仅供main-window使用
  async init() {}

  // 检测字符串是否包含中文字符
  containsChineseCharacters(str: string): boolean {
    const chineseRegex = /[\u4e00-\u9fa5]/;
    return chineseRegex.test(str);
  }

  // 新建项目
  async projectNew(newProjectData: NewProjectData) {
    try {
      this.uiService.updateFooterState({ state: 'doing', text: this.translate.instant('PROJECT.CREATING_PROJECT') });
      const created = await this.createServerProject(
        newProjectData.name,
        newProjectData.board.name,
        newProjectData.editor || 'blockly'
      );
      this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('PROJECT.PROJECT_CREATED') });
      await this.projectOpenById(created.projectId);
      return;
    } catch (error) {
      this.message.error(this.translate.instant('PROJECT.CREATE_FAILED') + ": " + error.message);
      this.uiService.updateFooterState({ state: 'error', text: this.translate.instant('PROJECT.CREATE_FAILED') });
    }
  }

  // 打开项目
  async projectOpen(projectPath = this.currentProjectPath) {
    const projectId = projectPath?.startsWith?.('server-project:')
      ? projectPath.replace('server-project:', '')
      : (projectPath || this.currentProjectId);
    return this.projectOpenById(projectId);
  }

  async projectOpenById(projectId: string) {
    if (!projectId) {
      this.message.error('项目 ID 为空');
      return;
    }
    await this.close(false);
    await new Promise(resolve => setTimeout(resolve, 100));
    this.stateSubject.next('loading');
    const projectInfo = await this.getServerProject(projectId);
    this.currentProjectId = projectId;
    this.currentPackageData = projectInfo.packageJson || { name: projectInfo.name };
    const editorRoute = projectInfo.editor === 'code' ? '/main/code-editor' : '/main/blockly-editor';
    this.router.navigate([editorRoute], {
      queryParams: { projectId },
      replaceUrl: true
    });
  }

  // 保存项目
  save(path = this.currentProjectPath) {
    return new Promise<{ success: boolean; error?: string; path?: string }>((resolve) => {
      this.stateSubject.next('saving');
      this.actionService.dispatch('project-save', { path }, async result => {
        if (result.success) {
          this.currentPackageData = await this.getPackageJson();
          this.stateSubject.next('saved');
          resolve({ success: true, path });
        } else {
          console.warn('项目保存失败:', result.error);
          this.stateSubject.next('error');
          resolve({ success: false, error: result.error, path });
        }
      });
    });
  }


  async close(navigate = true) {
    this.currentProjectPath = '';
    this.currentProjectId = '';
    this.currentPackageData = {
      name: 'Cycore MCU DevCloud',
    };
    this.stateSubject.next('default');
    this.uiService.closeTerminal();
    if (navigate) {
      this.router.navigate(['/main/guide'], { replaceUrl: true });
    }
  }

  // 通过ConfigService存储最近打开的项目
  get recentlyProjects(): any[] {
    return this.configService.data?.recentlyProjects || [];
  }

  set recentlyProjects(data) {
    this.configService.data.recentlyProjects = data;
    this.configService.save();
  }

  addRecentlyProject(data: { name: string, path: string, nickname?: string }) {
    let temp: any[] = this.recentlyProjects
    temp.unshift(data);
    temp = temp.filter((item, index) => {
      return temp.findIndex((item2) => item2.path === item.path) === index;
    });
    if (temp.length > 6) {
      temp.pop();
    }
    this.recentlyProjects = temp;
  }

  removeRecentlyProject(data: { path: string }) {
    let temp: any[] = this.recentlyProjects
    temp = temp.filter((item) => {
      return item.path !== data.path;
    });
    this.recentlyProjects = temp;
  }

  // 检查项目是否未保存
  async hasUnsavedChanges(): Promise<boolean> {
    // 如果项目尚未加载，则没有未保存的更改
    if (this.stateSubject.value === 'default' || !this.currentProjectPath) {
      return false;
    }

    return new Promise((resolve) => {
      this.actionService.dispatch('project-check-unsaved', {}, (result) => {
        console.log(result);
        resolve(result.data.hasUnsavedChanges);
      });
    });
  }

  // 获取当前项目的package.json
  async getPackageJson() {
    if (!this.currentProjectId) {
      return null;
    }
    const projectInfo = await this.getServerProject(this.currentProjectId);
    return projectInfo.packageJson;
  }

  async setPackageJson(data: any) {
    if (!this.currentProjectId) {
      throw new Error('当前项目 ID 未设置');
    }
    const currentPackageJson = await this.getPackageJson();
    if (JSON.stringify(currentPackageJson) === JSON.stringify(data)) {
      return;
    }
    if (currentPackageJson) {
      data = { ...currentPackageJson, ...data };
    }
    await this.saveServerFile('package.json', JSON.stringify(data, null, 2));
    this.currentPackageData = data;
  }

  /**
   * 添加或更新宏定义
   * @param macro 宏定义字符串，如 "BOARD_SCREEN_COMBO=501"
   */
  async addMacro(macro: string) {
    const pkg = await this.getPackageJson();
    if (!pkg.MACROS) {
      pkg.MACROS = [];
    }

    // 规范化为字符串数组（如果存储为 [[...], [...]] 则取首元素）
    const normalized: string[] = (pkg.MACROS || []).map((m: any) => {
      if (Array.isArray(m)) return String(m[0] || '').trim();
      return String(m || '').trim();
    }).filter((s: string) => s.length > 0);

    // 提取宏名称（等号前的部分），并支持无等号的宏定义
    const macroName = macro.split('=')[0];

    // 查找已有的同名项（以名称为准，不区分是否带赋值）
    const existingIndex = normalized.findIndex((entry) => {
      const entryName = entry.split('=')[0];
      return entryName === macroName;
    });

    if (existingIndex !== -1) {
      // 替换同名项
      normalized[existingIndex] = macro;
    } else {
      // 追加新宏
      normalized.push(macro);
    }

    // 在写入前再次读取最新的 package.json，防止并发写入覆盖
    const latestPkg = await this.getPackageJson();
    if (!latestPkg.MACROS) latestPkg.MACROS = [];

    // 规范化并写回到最新 pkg
    latestPkg.MACROS = normalized.map(s => [s]);

    console.log('addMacro -> normalized macros to write:', latestPkg.MACROS);
    await this.setPackageJson(latestPkg);
    console.log('✅ 添加宏定义:', macro, '当前宏列表:', latestPkg.MACROS);
  }

  /**
   * 删除宏定义
   * @param macroName 宏名称，如 "BOARD_SCREEN_COMBO"
   */
  async removeMacro(macroName: string) {
    const pkg = await this.getPackageJson();
    if (!pkg.MACROS || pkg.MACROS.length === 0) {
      return;
    }

    // 规范化为字符串数组（兼容 ['A'] 或 [['A=1']] 等存储形式）
    const normalized: string[] = (pkg.MACROS || []).map((m: any) => {
      if (Array.isArray(m)) return String(m[0] || '').trim();
      return String(m || '').trim();
    }).filter((s: string) => s.length > 0);

    // 过滤掉名称匹配的宏（既匹配 "NAME" 又匹配 "NAME=..."）
    const filtered = normalized.filter(entry => {
      const name = entry.split('=')[0];
      return name !== macroName;
    });

    // 在写入前再次读取最新的 package.json，防止并发写入覆盖
    const latestPkg = await this.getPackageJson();
    if (!latestPkg.MACROS) latestPkg.MACROS = [];

    latestPkg.MACROS = filtered.map(s => [s]);
    console.log('removeMacro -> normalized macros to write:', latestPkg.MACROS);
    await this.setPackageJson(latestPkg);
    console.log('🗑️ 删除宏定义:', macroName, '当前宏列表:', latestPkg.MACROS);
  }

  /**
   * 获取所有宏定义
   * @returns 宏定义数组，如 ["BOARD_SCREEN_COMBO=501", "BBXX"]
   */
  async getMacros(): Promise<string[]> {
    const pkg = await this.getPackageJson();
    if (!pkg.MACROS || pkg.MACROS.length === 0) {
      return [];
    }
    return (pkg.MACROS || []).map((m: any) => {
      if (Array.isArray(m)) return String(m[0] || '');
      return String(m || '');
    }).filter((s: string) => s.length > 0);
  }

  /**
   * 获取编译时的宏定义参数
   * @returns 如 "BOARD_SCREEN_COMBO=501,BBXX"
   */
  async getBuildMacrosString(): Promise<string> {
    const macros = await this.getMacros();
    return macros.join(',');
  }

  // 获取开发板名称
  async getBoardModule() {
    const prjPackageJson = await this.getPackageJson();
    return Object.keys(prjPackageJson.dependencies).find(dep => dep.startsWith('@aily-project/board-'));
  }

  async loadServerBoards(): Promise<ServerBoardInfo[]> {
    return this.unwrap<ServerBoardInfo[]>(this.http.get<ApiResult<ServerBoardInfo[]>>(API.serverProjectBoards));
  }

  loadServerLibraries$(
    keyword = '',
    page = 1,
    pageSize = 24,
    lang = ''
  ): Observable<ServerLibraryPage<ServerLibraryListItem>> {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    if (keyword) {
      params.set('keyword', keyword);
    }
    if (lang) {
      params.set('lang', lang);
    }
    return this.http.get<ApiResult<ServerLibraryPage<ServerLibraryListItem>>>(
      `${API.serverProjectLibraries}?${params.toString()}`
    ).pipe(
      rxMap(response => this.unwrapResponse(response))
    );
  }

  async loadServerLibraries(
    keyword = '',
    page = 1,
    pageSize = 24,
    lang = ''
  ): Promise<ServerLibraryPage<ServerLibraryListItem>> {
    return firstValueFrom(this.loadServerLibraries$(keyword, page, pageSize, lang));
  }

  async createServerProject(
    name: string,
    boardName: string,
    editor: 'blockly' | 'code' = 'blockly'
  ): Promise<{ projectId: string; name: string; editor: string; boardName: string }> {
    return this.unwrap(this.http.post<ApiResult<{ projectId: string; name: string; editor: string; boardName: string }>>(
      API.serverProjects,
      { name, boardName, editor }
    ));
  }

  async importPublicProject(
    archive: Blob,
    project: {
      name: string;
      nickname?: string;
      description?: string;
      docUrl?: string;
      tags?: string[];
    }
  ): Promise<{ projectId: string; name: string; editor: string; boardName: string }> {
    const formData = new FormData();
    formData.append('archive', archive, `${project.name || 'public_project'}.7z`);
    formData.append('name', project.name || 'public_project');
    formData.append('nickname', project.nickname || project.name || 'public_project');
    formData.append('description', project.description || '');
    formData.append('docUrl', project.docUrl || '');
    formData.append('tags', JSON.stringify(project.tags || []));
    return this.unwrap(this.http.post<ApiResult<{ projectId: string; name: string; editor: string; boardName: string }>>(
      `${API.serverProjects}/import`,
      formData
    ));
  }

  async loadServerProjects(page = 1, pageSize = 12): Promise<ServerProjectPage<ServerProjectListItem>> {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    return this.unwrap<ServerProjectPage<ServerProjectListItem>>(
      this.http.get<ApiResult<ServerProjectPage<ServerProjectListItem>>>(`${API.serverProjects}?${params.toString()}`)
    );
  }

  async deleteServerProject(projectId: string): Promise<void> {
    await this.unwrap<void>(
      this.http.delete<ApiResult<void>>(`${API.serverProjects}/${encodeURIComponent(projectId)}`)
    );
  }

  async updateServerProject(projectId: string, name: string): Promise<ServerProjectInfo> {
    return this.unwrap<ServerProjectInfo>(
      this.http.put<ApiResult<ServerProjectInfo>>(`${API.serverProjects}/${encodeURIComponent(projectId)}`, { name })
    );
  }

  async isServerProjectNameTaken(name: string): Promise<boolean> {
    const normalizedName = (name || '').trim().toLowerCase();
    if (!normalizedName) {
      return false;
    }

    const pageSize = 60;
    let page = 1;
    while (true) {
      const result = await this.loadServerProjects(page, pageSize);
      if ((result.records || []).some(project => (project.name || '').trim().toLowerCase() === normalizedName)) {
        return true;
      }
      if (page * pageSize >= (result.total || 0)) {
        return false;
      }
      page += 1;
    }
  }

  async getServerProject(projectId = this.currentProjectId): Promise<ServerProjectInfo> {
    return this.unwrap<ServerProjectInfo>(this.http.get<ApiResult<ServerProjectInfo>>(`${API.serverProjects}/${encodeURIComponent(projectId)}`));
  }

  async getServerProjectUploadOptions(projectId = this.currentProjectId): Promise<ServerProjectUploadOptions> {
    return this.unwrap<ServerProjectUploadOptions>(
      this.http.get<ApiResult<ServerProjectUploadOptions>>(`${API.serverProjects}/${encodeURIComponent(projectId)}/upload-options`)
    );
  }

  async getServerProjectLibraries(projectId = this.currentProjectId, forceRefresh = false): Promise<any[]> {
    if (!projectId) {
      return [];
    }
    if (!forceRefresh && this.serverProjectLibrariesCache.has(projectId)) {
      return this.cloneLibraryList(this.serverProjectLibrariesCache.get(projectId) || []);
    }
    const existingRequest = this.serverProjectLibrariesInFlight.get(projectId);
    if (!forceRefresh && existingRequest) {
      return this.cloneLibraryList(await existingRequest);
    }

    const request = this.unwrap<ServerProjectLibraries>(
      this.http.get<ApiResult<ServerProjectLibraries>>(
        `${API.serverProjects}/${encodeURIComponent(projectId)}/libraries`
      )
    ).then(result => {
      const libraries = result?.libraries || [];
      this.serverProjectLibrariesCache.set(projectId, libraries);
      return libraries;
    }).finally(() => {
      if (this.serverProjectLibrariesInFlight.get(projectId) === request) {
        this.serverProjectLibrariesInFlight.delete(projectId);
      }
    });
    this.serverProjectLibrariesInFlight.set(projectId, request);
    return this.cloneLibraryList(await request);
  }

  async installServerProjectLibrary(name: string, projectId = this.currentProjectId): Promise<any[]> {
    const result = await this.unwrap<ServerProjectLibraries>(
      this.http.post<ApiResult<ServerProjectLibraries>>(`${API.serverProjects}/${encodeURIComponent(projectId)}/libraries`, { name })
    );
    const libraries = result?.libraries || [];
    this.serverProjectLibrariesCache.set(projectId, libraries);
    this.syncServerLibraryDependencies(libraries);
    this.clearServerBlocklyResourceCache(projectId);
    return this.cloneLibraryList(libraries);
  }

  async removeServerProjectLibrary(name: string, projectId = this.currentProjectId): Promise<any[]> {
    const encodedName = this.encodeLibraryNameForPath(name);
    const result = await this.unwrap<ServerProjectLibraries>(
      this.http.delete<ApiResult<ServerProjectLibraries>>(`${API.serverProjects}/${encodeURIComponent(projectId)}/libraries/${encodedName}`)
    );
    const libraries = result?.libraries || [];
    this.serverProjectLibrariesCache.set(projectId, libraries);
    this.syncServerLibraryDependencies(libraries);
    this.clearServerBlocklyResourceCache(projectId);
    return this.cloneLibraryList(libraries);
  }

  async getServerBlockly(projectId = this.currentProjectId): Promise<any> {
    const result = await this.unwrap<{ workspace: any }>(
      this.http.get<ApiResult<{ workspace: any }>>(`${API.serverProjects}/${encodeURIComponent(projectId)}/blockly`)
    );
    return result?.workspace || {};
  }

  async saveServerBlockly(workspace: any, projectId = this.currentProjectId): Promise<void> {
    await this.unwrap<void>(
      this.http.put<ApiResult<void>>(`${API.serverProjects}/${encodeURIComponent(projectId)}/blockly`, { workspace })
    );
  }

  async getServerBlocklyLibraryResources(
    names: string[],
    dependencyVersions: Record<string, string> = {},
    lang = this.translate.currentLang,
    projectId = this.currentProjectId
  ): Promise<ServerBlocklyLibraryResource[]> {
    if (!projectId || !names?.length) {
      return [];
    }

    const normalizedLang = this.normalizeServerBlocklyResourceLang(lang);
    const uniqueNames = Array.from(new Set(names.filter(name => !!name)));
    const missingNames = uniqueNames.filter(name => {
      const cacheKey = this.serverBlocklyResourceCacheKey(projectId, name, dependencyVersions[name], normalizedLang);
      return !this.serverBlocklyResourceCache.has(cacheKey);
    });

    if (missingNames.length > 0) {
      const result = await this.unwrap<ServerBlocklyLibraryResources>(
        this.http.post<ApiResult<ServerBlocklyLibraryResources>>(
          `${API.serverProjects}/${encodeURIComponent(projectId)}/blockly-library-resources`,
          { names: missingNames, lang: normalizedLang }
        )
      );
      (result?.libraries || []).forEach(resource => {
        const cacheKey = this.serverBlocklyResourceCacheKey(projectId, resource.name, dependencyVersions[resource.name], normalizedLang);
        this.serverBlocklyResourceCache.set(cacheKey, this.cloneServerBlocklyResource(resource));
      });
    }

    return uniqueNames
      .map(name => this.serverBlocklyResourceCache.get(
        this.serverBlocklyResourceCacheKey(projectId, name, dependencyVersions[name], normalizedLang)
      ))
      .filter((resource): resource is ServerBlocklyLibraryResource => !!resource)
      .map(resource => this.cloneServerBlocklyResource(resource));
  }

  async getServerFileTree(projectId = this.currentProjectId): Promise<ServerFileNode[]> {
    return this.unwrap<ServerFileNode[]>(
      this.http.get<ApiResult<ServerFileNode[]>>(`${API.serverProjects}/${encodeURIComponent(projectId)}/files/tree`)
    );
  }

  async readServerFile(path: string, projectId = this.currentProjectId): Promise<string> {
    const result = await this.unwrap<{ path: string; content: string }>(
      this.http.get<ApiResult<{ path: string; content: string }>>(
        `${API.serverProjects}/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`
      )
    );
    return result?.content || '';
  }

  async saveServerFile(path: string, content: string, projectId = this.currentProjectId): Promise<void> {
    await this.unwrap<void>(
      this.http.put<ApiResult<void>>(`${API.serverProjects}/${encodeURIComponent(projectId)}/files`, { path, content })
    );
  }

  async convertServerProjectToProfessionalMode(code: string, projectId = this.currentProjectId): Promise<ServerProjectInfo> {
    const projectInfo = await this.unwrap<ServerProjectInfo>(
      this.http.post<ApiResult<ServerProjectInfo>>(
        `${API.serverProjects}/${encodeURIComponent(projectId)}/professional-mode`,
        { code: code || '' }
      )
    );
    this.currentProjectId = projectInfo.projectId;
    this.currentPackageData = projectInfo.packageJson || { name: projectInfo.name };
    this.serverProjectLibrariesCache.delete(projectId);
    this.clearServerBlocklyResourceCache(projectId);
    return projectInfo;
  }

  async compileServerProject(code?: string, projectId = this.currentProjectId): Promise<ServerCompileResult> {
    const result = await this.unwrap<ServerCompileResult>(
      this.http.post<ApiResult<ServerCompileResult>>(`${API.serverProjects}/${encodeURIComponent(projectId)}/compile`, { code })
    );
    this.lastServerCompileResult = result;
    return result;
  }

  async downloadServerArtifactFile(file: ServerFlashFile): Promise<ArrayBuffer> {
    return firstValueFrom(this.http.get(file.url, { responseType: 'arraybuffer' }));
  }

  private async unwrap<T>(request: any): Promise<T> {
    const response = await firstValueFrom(request) as ApiResult<T>;
    return this.unwrapResponse(response);
  }

  private unwrapResponse<T>(response: ApiResult<T>): T {
    if (!response || response.code !== 200) {
      throw new Error(response?.message || '服务端请求失败');
    }
    return response.data;
  }

  private cloneLibraryList(libraries: any[]): any[] {
    return libraries.map(library => ({ ...library }));
  }

  private syncServerLibraryDependencies(libraries: any[]): void {
    const packageData = this.currentPackageData as any;
    const dependencies = { ...(packageData.dependencies || {}) };
    Object.keys(dependencies)
      .filter(name => name.startsWith('@aily-project/lib-'))
      .forEach(name => delete dependencies[name]);
    (libraries || []).forEach(library => {
      if (library?.name?.startsWith('@aily-project/lib-')) {
        dependencies[library.name] = library.version || '*';
      }
    });
    packageData.dependencies = dependencies;
  }

  private serverBlocklyResourceCacheKey(projectId: string, name: string, version = '', lang = ''): string {
    return [projectId, name, version || '', lang || ''].join('::');
  }

  private cloneServerBlocklyResource(resource: ServerBlocklyLibraryResource): ServerBlocklyLibraryResource {
    return {
      ...resource,
      missingFiles: [...(resource.missingFiles || [])],
    };
  }

  private clearServerBlocklyResourceCache(projectId: string): void {
    if (!projectId) {
      return;
    }
    const prefix = `${projectId}::`;
    Array.from(this.serverBlocklyResourceCache.keys())
      .filter(key => key.startsWith(prefix))
      .forEach(key => this.serverBlocklyResourceCache.delete(key));
  }

  private normalizeServerBlocklyResourceLang(lang?: string): string {
    return (lang || '').trim().toLowerCase().replace('-', '_');
  }

  private encodeLibraryNameForPath(name: string): string {
    return btoa(unescape(encodeURIComponent(name)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  // 获取开发板模块的package.json
  async getBoardPackageJson() {
    const boardModule = await this.getBoardModule();
    return JSON.parse(await this.readServerFile(`node_modules/${boardModule}/package.json`));
  }

  // 获取开发板配置文件board.json
  async getBoardJson() {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    return JSON.parse(await this.readServerFile(`node_modules/${boardModule}/board.json`));
  }

  // 获取开发板根目录路下得特殊配置文件，如 ESP32 需要的 partitions.csv
  async getBoardFile(fileName: string) {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const filePath = `node_modules/${boardModule}/${fileName}`;
    try {
      await this.readServerFile(filePath);
      return filePath;
    } catch {
      return null;
    }
  }


  // 获取开发板特殊配置文件，如 STM32 需要的特殊配置
  async getJsonConfig(fileName: string) {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const configPath = `node_modules/${boardModule}/${fileName}`;
    return JSON.parse(await this.readServerFile(configPath));
  }

  // 修改开发板配置文件board.json， 如 STM32需要，传入新的data
  async setBoardJson(data: any) {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    const boardJsonPath = `node_modules/${boardModule}/board.json`;
    await this.save();
    this.message.loading(this.translate.instant('PROJECT.SWITCHING_BOARD_CONFIG'), { nzDuration: 5000 });

    const boardJson = JSON.parse(await this.readServerFile(boardJsonPath));
    Object.assign(boardJson, data);
    await this.saveServerFile(boardJsonPath, JSON.stringify(boardJson, null, 2));

    // 重新加载项目
    console.log('重新加载项目...');
    await this.projectOpen(this.currentProjectPath);

    // 通知开发板变更
    this.boardChangeSubject.next();
    this.uiService.updateFooterState({ state: 'done', text: this.translate.instant('PROJECT.BOARD_SWITCH_COMPLETE') });
    this.message.success(this.translate.instant('PROJECT.BOARD_SWITCH_SUCCESS'), { nzDuration: 3000 });
  }

  // 获取开发板package路径
  async getBoardPackagePath() {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    return `node_modules/${boardModule}`;
  }

  // 获取开发板 SDK 路径
  async getSdkPath() {
    return '';
  }

  // // 解析boards.txt并获取配置信息
  // async getBoardConfig(boardName: string, boardType: string) {

  // 解析boards.txt并获取ESP32配置信息
  async getEsp32BoardConfig(boardName: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const boardsFilePath = `${sdkPath}/boards.txt`;
      if (!window['fs'].existsSync(boardsFilePath)) {
        throw new Error('boards.txt 文件不存在: ' + boardsFilePath);
      }

      const boardsContent = window['fs'].readFileSync(boardsFilePath, 'utf8');
      const lines = boardsContent.split('\n');

      // 查找指定开发板的配置
      const boardConfig = this.parseBoardsConfig(lines, boardName);

      if (!boardConfig) {
        throw new Error(`未找到开发板 "${boardName}" 的配置`);
      }

      // 提取需要的配置项
      const esp32Config = {
        uploadSpeed: this.extractMenuOptions(boardConfig, 'UploadSpeed'),
        uploadMode: this.extractMenuOptions(boardConfig, 'UploadMode'),
        flashMode: this.extractMenuOptions(boardConfig, 'FlashMode'),
        flashFreq: this.extractMenuOptions(boardConfig, 'FlashFreq'),
        flashSize: this.extractMenuOptions(boardConfig, 'FlashSize'),
        partitionScheme: this.extractMenuOptions(boardConfig, 'PartitionScheme'),
        cdcOnBoot: this.extractMenuOptions(boardConfig, 'CDCOnBoot'),
        psram: this.extractMenuOptions(boardConfig, 'PSRAM')
      };

      return esp32Config;
    } catch (error) {
      console.error('获取ESP32开发板配置失败:', error);
      return null;
    }
  }

  // 解析boards.txt并获取STM32配置信息
  async getStm32BoardConfig(boardName: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const boardsFilePath = `${sdkPath}/boards.txt`;
      if (!window['fs'].existsSync(boardsFilePath)) {
        throw new Error('boards.txt 文件不存在: ' + boardsFilePath);
      }

      const boardsContent = window['fs'].readFileSync(boardsFilePath, 'utf8');
      const lines = boardsContent.split('\n');

      // 查找指定开发板的配置
      const boardConfig = this.parseBoardsConfig(lines, boardName);

      // console.log('====boardConfig:', boardConfig);

      if (!boardConfig) {
        throw new Error(`未找到开发板 "${boardName}" 的配置`);
      }

      const stm32Config = {
        board: this.extractMenuOptions(boardConfig, 'pnum'),
        usb: this.extractMenuOptions(boardConfig, 'usb'),
        // upload_method: this.extractMenuOptions(boardConfig, 'upload_method'),
      };

      // 只保留 name 字段中包含 "Generic" 的选项，其它全部去掉
      if (stm32Config.board && Array.isArray(stm32Config.board)) {
        stm32Config.board = stm32Config.board.filter(item => item.name && item.name.includes('Generic'));
      }

      return stm32Config;
    } catch (error) {
      console.error('获取STM32开发板配置失败:', error);
      return null;
    }
  }

  // 解析boards.txt文件内容，提取指定开发板的配置
  private parseBoardsConfig(lines: string[], boardName: string): { [key: string]: string } | null {
    const config: { [key: string]: string } = {};
    let foundBoard = false;
    let currentBoard = '';

    for (const line of lines) {
      const trimmedLine = line.trim();

      // 跳过空行和注释
      if (!trimmedLine || trimmedLine.startsWith('#')) {
        continue;
      }

      // 检查是否是开发板名称定义
      const nameMatch = trimmedLine.match(/^(\w+)\.name=(.+)$/);
      if (nameMatch) {
        currentBoard = nameMatch[1];
        foundBoard = (currentBoard === boardName);
        if (foundBoard) {
          config[`${currentBoard}.name`] = nameMatch[2];
        }
        continue;
      }

      // 以boardName.开头的行表示当前开发板的配置
      if (!foundBoard) {
        if (trimmedLine.startsWith(`${boardName}.`)) {
          foundBoard = true;
          currentBoard = boardName;
        }
      }

      // 如果找到了目标开发板，继续收集配置
      if (foundBoard && trimmedLine.startsWith(`${boardName}.`)) {
        const configMatch = trimmedLine.match(/^([^=]+)=(.*)$/);
        if (configMatch) {
          config[configMatch[1]] = configMatch[2];
        }
      }

      // 如果遇到了新的开发板定义且不是目标开发板，停止收集
      if (foundBoard && nameMatch && nameMatch[1] !== boardName) {
        break;
      }
    }

    return Object.keys(config).length > 0 ? config : null;
  }

  // 比较FlashMode配置是否完全匹配
  private compareFlashModeConfig(childBuild: any, currentBuild: any): boolean {
    // FlashMode相关的配置项
    const flashModeKeys = ['flash_mode', 'boot', 'boot_freq', 'flash_freq'];

    for (const key of flashModeKeys) {
      // 如果子配置中有这个键，那么必须与当前配置匹配
      if (childBuild.hasOwnProperty(key)) {
        if (childBuild[key] !== currentBuild[key]) {
          return false;
        }
      }
    }

    return true;
  }

  // 通用的配置比较方法
  private compareConfigs(childData: any, currentData: any): boolean {
    if (!childData || !currentData) {
      return false;
    }

    if (childData && currentData) {
      if (childData !== currentData) {
        return false;
      }
    }
    // // 检查build配置
    // if (childData.build && currentData.build) {
    //   for (const key of configKeys) {
    //     if (childData.build.hasOwnProperty(key)) {
    //       if (childData.build[key] !== currentData.build[key]) {
    //         return false;
    //       }
    //     }
    //   }
    // }

    // // 检查upload配置
    // if (childData.upload && currentData.upload) {
    //   const uploadKeys = Object.keys(childData.upload);
    //   for (const key of uploadKeys) {
    //     if (childData.upload[key] !== currentData.upload[key]) {
    //       return false;
    //     }
    //   }
    // }

    return true;
  }

  // 提取菜单选项
  private extractMenuOptions(boardConfig: { [key: string]: string }, menuType: string): any[] {
    const options: any[] = [];
    const boardName = Object.keys(boardConfig)[0].split('.')[0];
    const menuPrefix = `${boardName}.menu.${menuType}.`;

    // 首先收集所有选项的基本信息
    const optionDatas = new Set<string>();

    for (const key in boardConfig) {
      if (key.startsWith(menuPrefix)) {
        const remainingPath = key.replace(menuPrefix, '');
        const optionData = remainingPath.split('.')[0];

        // 只处理主选项，不处理子属性
        if (!remainingPath.includes('.') || remainingPath.split('.').length === 2) {
          optionDatas.add(optionData);
          // console.log('Found option data:', optionData);
        }
      }
    }

    // 构建选项列表，只包含key和data，key为menuType，data为optionData
    optionDatas.forEach(optionData => {
      const option = {
        name: boardConfig[`${menuPrefix}${optionData}`] || optionData,
        key: menuType,
        data: optionData,
        check: false,
        // // 其他属性 如 build.variant
        extra: {
          build: {
            variant: boardConfig[`${menuPrefix}${optionData}.build.variant`] || '',
            variant_h: boardConfig[`${menuPrefix}${optionData}.build.variant_h`] || ''
          }
        }
      }

      // console.log(`==========>>>${menuPrefix}${optionData}:`, boardConfig[`${menuPrefix}${optionData}.build.variant`] || '');
      // console.log('option:', option);

      // 清理空的配置对象
      if (Object.keys(option.data).length === 0) {
        delete option.data;
      }

      options.push(option);
    });

    // // 为每个选项构建完整的配置对象
    // optionKeys.forEach(optionKey => {
    //   const mainKey = `${menuPrefix}${optionKey}`;
    //   const optionName = boardConfig[mainKey];

    //   if (optionName) {
    //     const option = {
    //       name: optionName,
    //       key: menuType,
    //       data: {
    //         build: {},
    //         upload: {}
    //       },
    //       check: false
    //     };

    //     // 收集该选项的所有相关配置
    //     for (const key in boardConfig) {
    //       if (key.startsWith(`${menuPrefix}${optionKey}.`)) {
    //         const configPath = key.replace(`${menuPrefix}${optionKey}.`, '');
    //         const pathParts = configPath.split('.');

    //         if (pathParts.length === 2) {
    //           const category = pathParts[0]; // build 或 upload
    //           const property = pathParts[1]; // partitions, maximum_size 等

    //           if (category === 'build' || category === 'upload') {
    //             option.data[category][property] = boardConfig[key];
    //           }
    //         }
    //       }
    //     }

    //     // 清理空的配置对象
    //     if (Object.keys(option.data.build).length === 0) {
    //       delete option.data.build;
    //     }
    //     if (Object.keys(option.data.upload).length === 0) {
    //       delete option.data.upload;
    //     }
    //     if (Object.keys(option.data).length === 0) {
    //       delete option.data;
    //     }

    //     options.push(option);
    //   }
    // });
    return options;
  }

  // 更新ESP32配置菜单项
  async updateEsp32ConfigMenu(boardName: string) {
    if (!false) {
      if (!this.currentProjectId) {
        return null;
      }
      try {
        const options = await this.getServerProjectUploadOptions();
        return options?.menuItems || null;
      } catch (error) {
        console.error('获取服务端ESP32配置菜单失败:', error);
        return null;
      }
    }
    try {
      const boardConfig = await this.getEsp32BoardConfig(boardName);
      // console.log('获取到的ESP32开发板配置:', boardConfig);

      if (!boardConfig) {
        console.warn(`无法获取开发板 "${boardName}" 的配置`);
        return null;
      }

      // 读取当前项目的package.json配置
      let currentProjectConfig: any = {};
      try {
        const packageJson = await this.getPackageJson();
        currentProjectConfig = packageJson.projectConfig || {};
      } catch (error) {
        console.warn('无法读取项目配置:', error);
      }

      // 导入ESP32_CONFIG_MENU，需要动态导入以避免循环依赖
      // const { ESP32_CONFIG_MENU } = await import('../configs/esp32.config');
      let ESP32_CONFIG_MENU_TEMP = JSON.parse(JSON.stringify(ESP32_CONFIG_MENU));

      // 更新菜单项
      ESP32_CONFIG_MENU_TEMP.forEach(menuItem => {
        if (menuItem.name === 'ESP32.UPLOAD_SPEED' && boardConfig.uploadSpeed) {
          menuItem.children = boardConfig.uploadSpeed;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.UploadSpeed) {
            menuItem.children.forEach((child: any) => {
              child.check = false; // 先清空所有选中状态
              // 使用通用比较方法检查当前配置是否匹配
              if (this.compareConfigs(child.data, currentProjectConfig.UploadSpeed)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.UPLOAD_MODE' && boardConfig.uploadMode) {
          menuItem.children = boardConfig.uploadMode;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.UploadMode) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.UploadMode)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.FLASH_MODE' && boardConfig.flashMode) {
          // console.log('boardConfig.flashMode:', boardConfig.flashMode);
          menuItem.children = boardConfig.flashMode;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.FlashMode) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.FlashMode)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.FLASH_FREQ' && boardConfig.flashFreq) {
          menuItem.children = boardConfig.flashFreq;
          if (currentProjectConfig.FlashFreq) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.FlashFreq)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.FLASH_SIZE' && boardConfig.flashSize) {
          menuItem.children = boardConfig.flashSize;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.FlashSize) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.FlashSize)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.PARTITION_SCHEME' && boardConfig.partitionScheme) {
          menuItem.children = boardConfig.partitionScheme;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.PartitionScheme) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.PartitionScheme)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.CDC_ON_BOOT' && boardConfig.cdcOnBoot) {
          menuItem.children = boardConfig.cdcOnBoot;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.CDCOnBoot) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.CDCOnBoot)) {
                child.check = true;
              }
            });
          }
        } else if (menuItem.name === 'ESP32.PSRAM' && boardConfig.psram) {
          menuItem.children = boardConfig.psram;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.PSRAM) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.PSRAM)) {
                child.check = true;
              }
            });
          }
        }
      });
      return ESP32_CONFIG_MENU_TEMP;
    } catch (error) {
      console.error('更新ESP32配置菜单失败:', error);
      return null;
    }
  }

  // 更新STM32配置菜单项
  async updateStm32ConfigMenu(boardName: string) {
    if (!false) {
      return null;
    }
    try {
      const boardConfig = await this.getStm32BoardConfig(boardName);

      if (!boardConfig) {
        console.warn(`无法获取开发板 "${boardName}" 的配置`);
        return null;
      }

      // 读取当前项目的package.json配置
      let currentProjectConfig: any = {};
      let packageJson: any = {};
      try {
        packageJson = await this.getPackageJson();
        currentProjectConfig = packageJson.projectConfig || {};
      } catch (error) {
        console.warn('无法读取项目配置:', error);
      }

      let STM32_CONFIG_MENU_TEMP = JSON.parse(JSON.stringify(STM32_CONFIG_MENU));

      // 更新菜单项
      STM32_CONFIG_MENU_TEMP.forEach(menuItem => {
        if (menuItem.name === 'STM32.BOARD' && boardConfig.board) {
          menuItem.children = boardConfig.board;
          // 根据当前项目配置设置check状态
          // console.log('menuItem.children:', menuItem.children);
          if (currentProjectConfig.pnum) {
            menuItem.children.forEach((child: any) => {
              child.check = false; // 先清空所有选中状态
              if (this.compareConfigs(child.data, currentProjectConfig.pnum)) {
                child.check = true;
                // console.log('=============================================');
                // console.log('child:', child);
                this.currentStm32Config.board = child.data;
                this.currentStm32Config.variant = child.extra?.build.variant || null;
                this.currentStm32Config.variant_h = child.extra?.build.variant_h || null;
                // console.log('Selected STM32 pin config:', this.currentStm32Config);
                // console.log('=============================================');
              }
            });
          } else {
            // 如果项目配置中没有pnum，则默认选中第一个
            if (menuItem.children.length > 0) {
              menuItem.children[0].check = true;
              packageJson['projectConfig'] = packageJson['projectConfig'] || {};
              packageJson['projectConfig']['pnum'] = menuItem.children[0].data;
              // 更新项目配置
              this.setPackageJson(packageJson);
              this.compareStm32PinConfig(menuItem.children[0]);
            }
          }
        } else if (menuItem.name === 'STM32.USB' && boardConfig.usb) {
          menuItem.children = boardConfig.usb;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.usb) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.usb)) {
                child.check = true;
              }
            });
          }
          // } else if (menuItem.name === 'STM32.UPLOAD_METHOD' && boardConfig.upload_method) {
          //   menuItem.children = boardConfig.upload_method;
          //   // 根据当前项目配置设置check状态
          //   if (currentProjectConfig.upload_method) {
          //     menuItem.children.forEach((child: any) => {
          //       child.check = false;
          //       if (this.compareConfigs(child.data, currentProjectConfig.upload_method)) {
          //         child.check = true;
          //       }
          //     });
          //   }
        }
      });
      return STM32_CONFIG_MENU_TEMP;
    } catch (error) {
      console.error('更新STM32配置菜单失败:', error);
      return null;
    }
  }

  // 解析boards.txt并获取nRF5配置信息
  async getNrf5BoardConfig(boardName: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const boardsFilePath = `${sdkPath}/boards.txt`;
      if (!window['fs'].existsSync(boardsFilePath)) {
        throw new Error('boards.txt 文件不存在: ' + boardsFilePath);
      }

      const boardsContent = window['fs'].readFileSync(boardsFilePath, 'utf8');
      const lines = boardsContent.split('\n');

      // 查找指定开发板的配置
      const boardConfig = this.parseBoardsConfig(lines, boardName);

      if (!boardConfig) {
        throw new Error(`未找到开发板 "${boardName}" 的配置`);
      }

      // 提取nRF5需要的配置项
      const nrf5Config = {
        softdevice: this.extractMenuOptions(boardConfig, 'softdevice'),
      };

      return nrf5Config;
    } catch (error) {
      console.error('获取nRF5开发板配置失败:', error);
      return null;
    }
  }

  // 更新nRF5配置菜单项
  async updateNrf5ConfigMenu(boardName: string) {
    if (!false) {
      return null;
    }
    try {
      const boardConfig = await this.getNrf5BoardConfig(boardName);

      if (!boardConfig) {
        console.warn(`无法获取开发板 "${boardName}" 的配置`);
        return null;
      }

      // 读取当前项目的package.json配置
      let currentProjectConfig: any = {};
      try {
        const packageJson = await this.getPackageJson();
        currentProjectConfig = packageJson.projectConfig || {};
      } catch (error) {
        console.warn('无法读取项目配置:', error);
      }

      let NRF5_CONFIG_MENU_TEMP = JSON.parse(JSON.stringify(NRF5_CONFIG_MENU));

      // 更新菜单项
      NRF5_CONFIG_MENU_TEMP.forEach(menuItem => {
        if (menuItem.name === 'NRF5.SOFTDEVICE' && boardConfig.softdevice) {
          menuItem.children = boardConfig.softdevice;
          // 根据当前项目配置设置check状态
          if (currentProjectConfig.softdevice) {
            menuItem.children.forEach((child: any) => {
              child.check = false;
              if (this.compareConfigs(child.data, currentProjectConfig.softdevice)) {
                child.check = true;
              }
            });
          }
        }
      });

      return NRF5_CONFIG_MENU_TEMP;
    } catch (error) {
      console.error('更新nRF5配置菜单失败:', error);
      return null;
    }
  }

  /**
   * 获取 softdevice hex 文件路径
   * 路径格式: {appDataPath}/sdk/nrf5_{version}/cores/nRF5/SDK/components/softdevice/{softdevice}/hex/{softdevice}_nrf51_2.0.0_softdevice.hex
   * @param softdeviceName softdevice 名称，如 "s110" 或 "none"
   * @returns softdevice hex 文件路径，如果不存在则返回 null
   */
  async getSoftdeviceHexPath(softdeviceName: string): Promise<string | null> {
    try {
      // 获取 SDK 路径
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        console.error('未找到 SDK 路径');
        return null;
      }

      // 构建 softdevice 目录路径
      // 路径: sdk/nrf5_x.x.x/cores/nRF5/SDK/components/softdevice/{softdevice}/hex/
      const softdeviceDir = window['path'].join(
        sdkPath,
        'cores',
        'nRF5',
        'SDK',
        'components',
        'softdevice',
        softdeviceName,
        'hex'
      );

      console.log('Softdevice 目录路径:', softdeviceDir);

      if (!window['fs'].existsSync(softdeviceDir)) {
        console.error('Softdevice 目录不存在:', softdeviceDir);
        return null;
      }

      // 查找 hex 文件
      const files = window['fs'].readdirSync(softdeviceDir);
      const hexFile = files.find((file: string) => file.endsWith('.hex'));

      if (!hexFile) {
        console.error('未找到 hex 文件:', softdeviceDir);
        return null;
      }

      const hexPath = window['path'].join(softdeviceDir, hexFile);
      console.log('Softdevice hex 文件路径:', hexPath);
      return hexPath;
    } catch (error) {
      console.error('获取 softdevice hex 路径失败:', error);
      return null;
    }
  }

  // 比较stm32引脚配置
  async compareStm32PinConfig(pinConfig: any): Promise<boolean> {
    // console.log('=============================================');
    // console.log('Comparing STM32 pin config:', pinConfig, "||", this.currentStm32Config);
    if (pinConfig.data == this.currentStm32Config.board) {
      return true;
    } else if (pinConfig.extra?.build.variant == this.currentStm32Config.variant) {
      return true;
    } else {
      let newPinConfig = pinConfig;

      // newPinConfig = this.parseGenericConfig(newPinConfig);
      // console.log('=============================================');
      // console.log('newPinConfig:', newPinConfig);

      let variant = newPinConfig.extra?.build.variant || null;
      let variant_h = newPinConfig.extra?.build.variant_h || 'variant_generic.h';

      const setPinConfig = await this.getVariantConfig(variant, variant_h);
      const currentBoardJson = await this.getBoardJson();

      let isChanged = false;

      if (typeof setPinConfig === 'object' && setPinConfig !== null) {
        Object.keys(setPinConfig).forEach(key => {
          if (Array.isArray(setPinConfig[key])) {
            if (JSON.stringify(currentBoardJson[key]) !== JSON.stringify(setPinConfig[key])) {
              currentBoardJson[key] = setPinConfig[key];
              isChanged = true;
            }
          }
        });
      }

      // 保存更新后的board.json
      if (isChanged) {
        await this.setBoardJson(currentBoardJson);
        this.currentStm32Config.board = pinConfig.data;
        this.currentStm32Config.variant = variant;
        this.currentStm32Config.variant_h = variant_h;
        // console.log('Updated STM32 pin config:', this.currentStm32Config);
      }

      // // // 获取到的config格式为“STM32F1xx/F100C(4-6)T”
      // // // 我们需要转换为“F1XXC”
      // // // 支持 STM32F1xx/F103C、STM32F4xx/F407V、STM32H7xx/H767Z、STM32C0xx/C030F 等
      // // const match = newPinConfig.match(/STM32([A-Z]\d?)xx\/[A-Z]\d{3}([A-Z])/i);
      // // if (match) {
      // //   // match[1] 可能是 F1、F4、H7、C0 等，match[2] 是主型号字母
      // //   newPinConfig = match[1].toUpperCase() + 'XX' + match[2].toUpperCase();
      // // }
      // // console.log('newPinConfig:', newPinConfig);
      // // 读取特殊配置文件
      // const newPinJson = await this.getJsonConfig(newPinConfig + '.pins.json');
      // // console.log('newPinJson:', newPinJson);
      // const currentBoardJson = await this.getBoardJson();
      // // console.log('currentBoardJson:', currentBoardJson);
      // let isChanged = false;
      // // 遍历newPinJson中的每一项，更新currentBoardJson中的对应项
      // if (typeof newPinJson === 'object' && newPinJson !== null) {
      //   // 如果 newPinJson 结构为 {analog: [...], digital: [...]}，则直接整体替换 currentBoardJson 的同名属性
      //   Object.keys(newPinJson).forEach(key => {
      //     // console.log(`Comparing key: ${key}`);
      //     if (Array.isArray(newPinJson[key])) {
      //       if (JSON.stringify(currentBoardJson[key]) !== JSON.stringify(newPinJson[key])) {
      //         currentBoardJson[key] = newPinJson[key];
      //         isChanged = true;
      //       }
      //     }
      //   });
      // } else {
      //   console.error('newPinJson 不是对象:', newPinJson);
      // }
      // // 保存更新后的board.json
      // if (isChanged) {
      //   await this.setBoardJson(currentBoardJson);
      //   this.currentStm32pinConfig = pinConfig;
      // }
      return false;
    }
  }

  // 根据传入的引脚信息解析引脚配置 如STM32F1xx/F100C(4-6)T
  async getVariantConfig(variant: string, variant_h: string) {
    try {
      const sdkPath = await this.getSdkPath();
      if (!sdkPath) {
        throw new Error('未找到 SDK 路径');
      }

      const variantFilePath = `${sdkPath}/variants/${variant}/${variant_h}`;
      // console.log('variantFilePath:', variantFilePath);
      if (!window['fs'].existsSync(variantFilePath)) {
        throw new Error('引脚配置文件不存在: ' + variantFilePath);
      }

      const variantContent = window['fs'].readFileSync(variantFilePath, 'utf8');

      return this.parseVariantConfig(variantContent);
    } catch (error) {
      console.error('解析STM32引脚配置失败:', error);
    }
  }

  private parseVariantConfig(content: string): any {
    const analogPins: any[] = [];
    const digitalPins: any[] = [];
    const i2cPins: any = { Wire: [] };
    const spiPins: any = { SPI: [] };

    const lines = content.split(/\r?\n/);
    const digitalSet = new Set<string>();
    const i2cMap: any = {};
    const spiMap: any = {};

    // 宽松匹配多种 define 写法：PA0 PIN_A0 或 PIN_A0 PA0 等
    const analogRe1 = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+(PIN_A\d+)\b/; // PA0  PIN_A0
    const analogRe2 = /^\s*#\s*define\s+(PIN_A\d+)\s+([A-Z]{1,3}\d{1,3})\b/; // PIN_A0 PA0

    const digitalRe1 = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+(\d+|PIN_A\d+)\b/; // PA1  1  或 PA1 PIN_A0
    const digitalRe2 = /^\s*#\s*define\s+(PIN_[A-Z0-9_]+)\s+(\d+|[A-Z]{1,3}\d{1,3})\b/; // PIN_LED 13 或 PIN_A0 PA0

    const i2cRe = /^\s*#\s*define\s+PIN_WIRE_(SDA|SCL)\s+([A-Z]{1,3}\d{1,3})\b/;
    const i2cReAlt = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+PIN_WIRE_(SDA|SCL)\b/;

    const spiRe = /^\s*#\s*define\s+PIN_SPI_(SS\d*|MOSI|MISO|SCK)\s+([A-Z]{1,3}\d{1,3})\b/;
    const spiReAlt = /^\s*#\s*define\s+([A-Z]{1,3}\d{1,3})\s+PIN_SPI_(SS\d*|MOSI|MISO|SCK)\b/;

    for (const line of lines) {
      // 去掉行尾注释
      const pureLine = line.replace(/\/\/.*$/, '').replace(/\/\*.*\*\/\s*$/, '');

      // analog
      let m = analogRe1.exec(pureLine) || analogRe2.exec(pureLine);
      if (m) {
        // 统一为 [pinMacro, port]，优先保留 PIN_Ax 做第一个元素以兼容 gen_boards 输出
        if (m[1].startsWith('PIN_A')) {
          analogPins.push([m[1], m[2]]);
        } else {
          analogPins.push([m[2], m[1]]);
        }
      }

      // digital
      m = digitalRe1.exec(pureLine) || digitalRe2.exec(pureLine);
      if (m) {
        // m[1] 是名字或 PIN_ 前缀，根据捕获组位置不同处理
        let name = m[1];
        let val = m[2];
        // 如果捕获到 PIN_* 在第一位（digitalRe2），将 name 与 val 调换以保持一致
        if (name.startsWith('PIN_')) {
          // 如果包含SPI WIRE SERIAL等关键字，则跳过
          if (name.includes('PIN_SPI_') || name.includes('PIN_WIRE_') || name.includes('PIN_SERIAL_')) {
            continue;
          }
          // 保证唯一性，使用宏名或引脚名作为标识
          const display = name;
          if (!digitalSet.has(display)) {
            digitalSet.add(display);
            digitalPins.push([display, display]);
          }
        } else {
          const display = name;
          if (!digitalSet.has(display)) {
            digitalSet.add(display);
            digitalPins.push([display, display]);
          }
        }
      }

      // i2c
      m = i2cRe.exec(pureLine);
      if (m) {
        i2cMap[m[1]] = m[2];
      } else {
        m = i2cReAlt.exec(pureLine);
        if (m) {
          i2cMap[m[2]] = m[1]; // alt captures port then PIN_WIRE_x
        }
      }

      // spi
      m = spiRe.exec(pureLine);
      if (m) {
        let key = m[1];
        if (key.startsWith('SS')) key = 'SS';
        spiMap[key] = m[2];
      } else {
        m = spiReAlt.exec(pureLine);
        if (m) {
          let key = m[2];
          if (key.startsWith('SS')) key = 'SS';
          spiMap[key] = m[1];
        }
      }
    }

    // i2c 输出顺序 SDA, SCL
    if (i2cMap['SDA']) i2cPins.Wire.push(['SDA', i2cMap['SDA']]);
    if (i2cMap['SCL']) i2cPins.Wire.push(['SCL', i2cMap['SCL']]);

    // SPI 输出固定顺序 MOSI, MISO, SCK, SS
    const spiOrder = ['MOSI', 'MISO', 'SCK', 'SS'];
    for (const k of spiOrder) {
      if (spiMap[k]) spiPins.SPI.push([k, spiMap[k]]);
    }

    // 结果格式与 gen_boards.js 相同
    return {
      analogPins,
      digitalPins,
      pwmPins: digitalPins,
      servoPins: digitalPins,
      interruptPins: digitalPins,
      i2cPins,
      spiPins
    };
  }

  private parseGenericConfig(config: string): string {
    // 匹配 GENERIC_F100C4TX、GENERIC_F103CB、GENERIC_F407VG 等格式
    // 识别后 输出F1XXC、F4XXV等格式
    // const match = config.match(/GENERIC_([A-Z])(\d{1,2})\d*[A-Z]?([A-Z])/i);
    // const match = config.match(/GENERIC_([A-Z])(\d?)\d*[A-Z]?([A-Z])/i);
    const match = config.match(/GENERIC_([A-Z])(\d)\d*([A-Z])/i);
    if (match) {
      // match[1] 提取主系列（如 F）
      // match[2] 提取数字部分（如 1、4、7、0）
      // match[3] 提取主型号字母（如 C、V、Z、F）
      return `${match[1]}${match[2]}XX${match[3]}`.toUpperCase();
    }
    console.warn('无法解析 GENERIC 配置:', config);
    return config; // 如果无法解析，返回原始字符串
  }

  // 获取项目配置
  async getProjectConfig() {
    try {
      const packageJson = await this.getPackageJson();
      if (!packageJson || !packageJson.projectConfig) {
        return {};
      }

      return packageJson.projectConfig;
    } catch (error) {
      console.info('获取项目配置失败:', error);
      return {}
    }
  }

  async changeBoard(boardInfo: { "name": string, "version": string }) {
    throw new Error(`浏览器版暂不支持直接切换开发板依赖: ${boardInfo.name}@${boardInfo.version}`);
  }

  generateUniqueProjectName(_prjPath: string, prefix = 'project_'): string {
    return `${prefix}${generateDateString()}_${Date.now().toString(36)}`;
  }

  /**
   * 获取当前项目的构建路径
   * @returns 返回构建路径
   */
  async getBuildPath(): Promise<string> {
    return '';
  }
}
