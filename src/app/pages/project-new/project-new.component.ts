import { Component, OnDestroy } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { ElectronService } from '../../services/electron.service';
import { ProjectService } from '../../services/project.service';
import { ConfigService } from '../../services/config.service';
import { ThemeMode, ThemeService } from '../../services/theme.service';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { TranslateModule } from '@ngx-translate/core';
import { Router } from '@angular/router';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { SequentialImgDirective } from './sequential-img.directive';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';

@Component({
  selector: 'app-project-new',
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzInputModule,
    NzSelectModule,
    TranslateModule,
    NzRadioModule,
    SequentialImgDirective,
    NzToolTipModule
  ],
  templateUrl: './project-new.component.html',
  styleUrl: './project-new.component.scss',
})
export class ProjectNewComponent implements OnDestroy {
  currentStep = 0;
  keyword = '';
  readonly defaultBoardImageDarkUrl = 'imgs/boards/default-board-dark.svg';
  readonly defaultBoardImageLightUrl = 'imgs/boards/default-board-light.svg';
  defaultBoardImageUrl = this.defaultBoardImageDarkUrl;
  private themeSubscription?: Subscription;

  currentBoard: any = null;
  newProjectData: NewProjectData = {
    name: '',
    path: '',
    board: {
      name: '',
      nickname: '',
      version: '',
    },
    devmode: ''
  };

  boardVersion = '';

  _boardList: any[] = [];
  boardList: any[] = [];

  get resourceUrl() {
    return this.configService.getCurrentResourceUrl();
  }

  get currentStepTitle(): string {
    if (this.currentStep === 0) return 'PROJECT_NEW.STEPS.SELECT_BOARD';
    if (this.currentStep === 1) return 'PROJECT_NEW.STEPS.BASIC_SETTINGS';
    return 'PROJECT_NEW.STEPS.CREATE_PROJECT';
  }

  constructor(
    private router: Router,
    private location: Location,
    private electronService: ElectronService,
    private projectService: ProjectService,
    private configService: ConfigService,
    private themeService: ThemeService
  ) { }

  async ngOnInit() {
    document.body.classList.add('project-new-overlay-open');
    this.updateDefaultBoardImage(this.themeService.currentTheme);
    this.themeSubscription = this.themeService.theme$.subscribe(theme => {
      this.updateDefaultBoardImage(theme);
    });
    const boards = (await this.projectService.loadServerBoards()).map(board => this.prepareBoard(board as BoardInfo));
    this._boardList = boards.sort((a, b) => {
      if (a.nickname === 'Cycore ESP32S3') return -1;
      if (b.nickname === 'Cycore ESP32S3') return 1;
      return 0;
    });

    this.boardList = JSON.parse(JSON.stringify(this._boardList));

    if (this.boardList.length > 0) {
      this.selectBoard(this.boardList[0]);
    }
  }

  ngOnDestroy() {
    document.body.classList.remove('project-new-overlay-open');
    this.themeSubscription?.unsubscribe();
  }

  private updateDefaultBoardImage(theme: ThemeMode) {
    this.defaultBoardImageUrl = theme === 'light'
      ? this.defaultBoardImageLightUrl
      : this.defaultBoardImageDarkUrl;
  }

  getBoardImageUrl(board?: BoardInfo | null): string {
    if (!board?.img) {
      return this.defaultBoardImageUrl;
    }
    return `${this.resourceUrl}/imgs/boards/${board.img}`;
  }

  useDefaultBoardImage(event: Event) {
    const img = event.target as HTMLImageElement;
    if (img.src.endsWith(this.defaultBoardImageUrl)) {
      return;
    }
    img.src = this.defaultBoardImageUrl;
  }

  search() {
    const keyword = this.keyword.trim().toLowerCase();
    if (!keyword) {
      this.boardList = JSON.parse(JSON.stringify(this._boardList));
    } else {
      this.boardList = this._boardList
        .filter(board => [
          board.name,
          board.nickname,
          board.brand,
          board.type,
          board.description
        ].some(value => `${value || ''}`.toLowerCase().includes(keyword)))
        .map(board => JSON.parse(JSON.stringify(board)));
    }

    if (this.boardList.length > 0) {
      const selectedBoard = this.boardList.find(board => board.name === this.currentBoard?.name) || this.boardList[0];
      this.selectBoard(selectedBoard);
    } else {
      this.currentBoard = null;
    }
  }

  private isAllowedBoard(board: BoardInfo): boolean {
    const brand = (board.brand || '').trim().toLowerCase();
    const identity = this.getBoardIdentity(board);
    const isWifiduinoEsp32S3Dev = identity.includes('wifiduinoesp32s3dev');
    const isExcludedModel = ['esp32c5', 'esp32c6', 'esp32s2'].some(model => identity.includes(model));
    const isWifiduino32S3 = identity.includes('wifiduino32s3');
    const isEspressif = brand.includes('espressif') || brand.includes('乐鑫');

    return isWifiduinoEsp32S3Dev || (isEspressif && !isExcludedModel && !isWifiduino32S3);
  }

  private prepareBoard(board: BoardInfo): BoardInfo {
    const preparedBoard = JSON.parse(JSON.stringify(board));
    if (this.getBoardIdentity(board).includes('wifiduinoesp32s3dev')) {
      preparedBoard.nickname = 'Cycore ESP32S3';
    }
    return preparedBoard;
  }

  private getBoardIdentity(board: BoardInfo): string {
    return `${board.name || ''} ${board.nickname || ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  devmodes = [];
  selectBoard(boardInfo: BoardInfo) {
    this.currentBoard = boardInfo;
    this.newProjectData.board.name = boardInfo.name;
    this.newProjectData.board.nickname = boardInfo.nickname;
    this.newProjectData.board.version = boardInfo.version;
    this.newProjectData.devmode = boardInfo.mode ? this.currentBoard.mode[0] : 'arduino';
    this.devmodes = boardInfo.mode;
  }

  // 可用版本列表
  boardVersionList: any[] = [];
  async nextStep() {
    this.boardVersionList = [this.newProjectData.board.version];
    this.currentStep = this.currentStep + 1;
  }

  // 检查项目名称是否存在
  showIsExist = false;
  async checkPathIsExist(): Promise<boolean> {
    const isExist = await this.projectService.isServerProjectNameTaken(this.newProjectData.name);
    this.showIsExist = isExist;
    return isExist;
  }

  showIsPathPassed = false;
  projectNameChecking = false;

  checkPathInvalidChars(): boolean {
    const name = this.newProjectData.name || '';
    this.showIsExist = false;
    const hasInvalid = !/^[^\p{N}\s][\p{L}\p{N}_-]{0,63}$/u.test(name);
    this.showIsPathPassed = hasInvalid;
    return hasInvalid;
  }

  generateRandomProjectName() {
    const adjectives = ['swift', 'bright', 'smart', 'tiny', 'nova', 'lucky', 'clear', 'rapid'];
    const nouns = ['chip', 'core', 'board', 'sensor', 'maker', 'logic', 'pilot', 'spark'];
    const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const suffix = Math.floor(1000 + Math.random() * 9000);
    this.newProjectData.name = `${adjective}_${noun}_${suffix}`;
    this.checkPathInvalidChars();
  }

  async createProject() {
    if (this.checkPathInvalidChars()) {
      return;
    }
    this.projectNameChecking = true;
    try {
      if (await this.checkPathIsExist()) {
        return;
      }
    } finally {
      this.projectNameChecking = false;
    }
    this.currentStep = 2;

    // 记录开发板使用次数
    this.configService.recordBoardUsage(this.newProjectData.board.name);

    await this.projectService.projectNew(this.newProjectData);
  }

  openUrl(url) {
    this.electronService.openUrl(url);
  }

  back() {
    // 检查是否有历史记录可以返回
    if (window.history.length > 1) {
      this.location.back();
    } else {
      // 如果没有历史记录，跳转到项目初始默认路径
      this.router.navigate(['/main/guide']);
    }
  }

}


export interface BoardInfo {
  "name": string, // 开发板在仓库中的名称开发板名称
  "nickname": string, // 显示的开发板名称
  "version": string,
  "img": string,
  "description": string,
  "url": string,
  "brand": string,
  "type"?: string, // 开发板类型/核心架构 (如 esp32:esp32, arduino:avr, etc)
  "mode"?: string[]
}

export interface NewProjectData {
  name: string,
  path: string,
  board: {
    name: string,
    nickname: string,
    version: string
  },
  devmode?: string
}
