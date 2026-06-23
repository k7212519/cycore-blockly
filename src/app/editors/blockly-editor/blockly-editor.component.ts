import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { LibManagerComponent } from './components/lib-manager/lib-manager.component';
import { NotificationComponent } from '../../components/notification/notification.component';
import { UiService } from '../../services/ui.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ActivatedRoute } from '@angular/router';
import { BrowserService } from '../../services/browser.service';
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
import { ActionService } from '../../services/action.service';
import { BlocklySvgExportService } from './services/blockly-svg-export.service';

@Component({
  selector: 'app-blockly-editor',
  imports: [
    BlocklyComponent,
    LibManagerComponent,
    NotificationComponent,
    TranslateModule,
    DevToolComponent,
  ],
  providers: [_BuilderService, _UploaderService, BitmapUploadService],
  templateUrl: './blockly-editor.component.html',
  styleUrl: './blockly-editor.component.scss',
})
export class BlocklyEditorComponent implements OnInit, OnDestroy {
  showLibraryManager = false;
  private unregisterSvgExportAction?: () => void;

  devmode;

  get developerMode() {
    return this.configService.isDevMode;
  }

  constructor(
    private cd: ChangeDetectorRef,
    private uiService: UiService,
    private activatedRoute: ActivatedRoute,
    private blocklyService: BlocklyService,
    private browserService: BrowserService,
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
    private actionService: ActionService,
    private blocklySvgExportService: BlocklySvgExportService,
  ) { }

  ngOnInit(): void {
    this.unregisterSvgExportAction = this.actionService.listen(
      'blockly-svg-export',
      () => this.blocklySvgExportService.exportAndDownload(),
      'blockly-svg-export-handler',
    );

    this.activatedRoute.queryParams.subscribe((params) => {
      if (params['projectId']) {
        console.log('project id', params['projectId']);
        try {
          this.loadServerProject(params['projectId']);
        } catch (error) {
          console.error('加载项目失败', error);
          this.message.error('加载项目失败，请检查项目文件是否完整');
        }
      } else {
        this.message.error('没有找到项目');
      }
    });

    this._projectService.init();
    this._builderService.init();
    this._uploadService.init();

    // 阻止鼠标按键前进后退
    window.history.replaceState(null, '', window.location.href);
    window.history.pushState(null, '', window.location.href);
  }

  ngOnDestroy(): void {
    document.body.classList.remove('lib-manager-overlay-open');
    this._projectService.destroy();
    this._builderService.cancel();
    this._builderService.destroy();
    this._uploadService.cancel();
    this._uploadService.destroy();
    this.unregisterSvgExportAction?.();
    this.browserService.setTitle('CYCORE-MCU-DevCloud');
    this.blocklyService.reset();
  }

  async loadServerProject(projectId: string) {
    this.projectService.currentProjectId = projectId;
    const projectPath = this.projectService.serverProjectPath(projectId);
    this._projectService.currentProjectPath = projectPath;

    const projectInfo = await this.projectService.getServerProject(projectId);
    const packageJson = projectInfo.packageJson || {};
    this.devmode = packageJson.devmode || 'arduino';
    this.browserService.setTitle(`CYCORE-MCU-DevCloud - ${packageJson.nickname || packageJson.name || projectInfo.name}`);

    this._projectService.currentPackageData = packageJson;
    this.projectService.currentPackageData = packageJson;
    window['packageJson'] = packageJson;
    window['projectService'] = this.projectService;

    this.uiService.updateFooterState({
      state: 'doing',
      text: this.translate.instant('BLOCKLY_EDITOR.LOADING_BOARD_CONFIG'),
    });
    const boardJson = await this.projectService.getBoardJson();
    this.projectService.currentBoardConfig = boardJson;
    this.blocklyService.boardConfig = boardJson;
    window['boardConfig'] = boardJson;

    this.uiService.updateFooterState({
      state: 'doing',
      text: this.translate.instant('BLOCKLY_EDITOR.LOADING_BLOCKLY_LIB'),
    });
    const dependencies = packageJson.dependencies || {};
    const libraryModuleList = Object.keys(dependencies).filter(name => this.isBlocklyLibraryDependency(name));
    await this.loadBlocklyLibraries(libraryModuleList, projectPath);

    this.uiService.updateFooterState({
      state: 'doing',
      text: this.translate.instant('BLOCKLY_EDITOR.LOADING_BLOCKLY_PROGRAM'),
    });
    const jsonData = await this.projectService.getServerBlockly(projectId);
    this.blocklyService.loadAbiJson(jsonData);
    this._projectService.markSavedSnapshot(jsonData);

    this.uiService.updateFooterState({
      state: 'done',
      text: this.translate.instant('BLOCKLY_EDITOR.PROJECT_LOAD_SUCCESS'),
    });
    this.projectService.stateSubject.next('loaded');
    this.checkBlocklyOnboarding();
  }

  openProjectManager(event?: MouseEvent) {
    if (this.blocklyService.checkAiWaiting()) {
      return;
    }
    // hideChaff 会关闭所有打开的下拉、输入、WidgetDiv 和 DropDownDiv
    this.blocklyService.workspace.hideChaff();
    // this.uiService.closeToolAll();
    this.setLibraryManagerOpen(!this.showLibraryManager);
  }

  setLibraryManagerOpen(open: boolean) {
    this.showLibraryManager = open;
    document.body.classList.toggle('lib-manager-overlay-open', open);
    this.cd.detectChanges();
  }

  // 检查是否需要显示新手引导
  private checkBlocklyOnboarding() {
    // 已根据用户请求移除新手指引提示
    return;
  }

  private async loadBlocklyLibraries(libraryModuleList: string[], projectPath: string): Promise<void> {
    await this.blocklyService.loadLibraries(
      libraryModuleList,
      projectPath,
      (libPackageName, index, total) => {
        this.uiService.updateFooterState({
          state: 'doing',
          text: this.translate.instant('BLOCKLY_EDITOR.LOADING_LIB', {
            name: `${libPackageName} (${index}/${total})`,
          }),
        });
      },
    );
  }

  private isBlocklyLibraryDependency(name: string): boolean {
    return name.startsWith('@aily-project/lib-');
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
