/* 这个服务用来控制窗口、工具的显示和隐藏，通过 Subject 来实现组件之间的通信。
 */
import { Injectable } from '@angular/core';
import { filter, Observable, Subject } from 'rxjs';
import { NavigationEnd, Router } from '@angular/router';
import { NzModalService } from 'ng-zorro-antd/modal';
import { ProjectSettingDialogComponent } from '../components/project-setting-dialog/project-setting-dialog.component';
import { EdaAuthService } from '../auth/eda-auth.service';

@Injectable({
  providedIn: 'root',
})
export class UiService {
  private readonly disabledCloudTools = new Set(['aily-chat', 'cloud-space', 'model-store']);

  // 用来控制窗口和工具的显示和隐藏
  actionSubject = new Subject();

  // 用来更新footer右下角的状态
  stateSubject = new Subject<ActionState>();

  // 用来记录当前已打开的工具
  openToolList: string[] = [];

  // 用来获取当前最上层的工具
  get topTool() {
    return this.openToolList[this.openToolList.length - 1] || null;
  }

  // 用来记录terminal是否打开
  terminalIsOpen = false;
  // 当前选中的底部面板tab
  currentBottomTab = '';
  theme = 'dark';
  isMainWindow = false;

  /**
   * 向 aily-chat 发送消息的 Subject。
   * 外部组件通过 openAndSendToChat() 触发，
   * aily-chat 模组内部订阅 chatMessage$ 消费。
   */
  private chatMessageSubject = new Subject<{ text: string; options?: Record<string, any> }>();
  chatMessage$ = this.chatMessageSubject.asObservable();


  constructor(
    private router: Router,
    private modal: NzModalService,
    private authService: EdaAuthService
  ) { }


  // 初始化UI服务，这个init函数仅供main-window使用
  init(): void {
    // 注册 window 全局方法，供非 Angular 环境调用
    (window as any).openAndSendToAilyChat = (text: string, options?: Record<string, any>) => {
      this.openAndSendToChat(text, options);
    };
    this.isMainWindow = true;
  }

  openWindow(opt: WindowOpts) {
    if (opt?.path) {
      if (opt.path.startsWith('iframe')) {
        this.openIframeModal(opt);
        return;
      }
      const mainRoutes = new Set(['project-new', 'playground']);
      const route = mainRoutes.has(opt.path) ? ['/main', opt.path] : ['/', opt.path];
      this.router.navigate(route, { queryParams: opt.queryParams });
    }
  }

  private openIframeModal(opt: WindowOpts): void {
    const url = this.extractIframeUrl(opt.path);
    if (!url) {
      return;
    }
    void import('../windows/iframe/iframe.component').then(({ IframeComponent }) => {
      this.modal.create({
        nzTitle: opt.title || null,
        nzFooter: null,
        nzClosable: true,
        nzContent: IframeComponent,
        nzData: {
          url,
          data: opt.data,
          title: opt.title,
          embedded: true,
        },
        nzWidth: opt.width || 900,
        nzBodyStyle: {
          padding: '0',
          height: `${opt.height || 700}px`,
          overflow: 'hidden',
        },
      });
    });
  }

  private extractIframeUrl(path: string): string | null {
    try {
      const [, query = ''] = path.split('?');
      const params = new URLSearchParams(query);
      return params.get('url');
    } catch {
      return null;
    }
  }

  // 这个方法是给header用的
  turnTool(opt: ToolOpts) {
    if (this.topTool == opt.data) {
      this.closeTool(opt.data);
    } else {
      this.openTool(opt.data);
    }
  }

  // 如果其它组件/程序要打开工具，调用这个方法
  openTool(name: string) {
    if (this.disabledCloudTools.has(name)) {
      console.warn(`Tool "${name}" is disabled in this build.`);
      return;
    }
    // if (name == 'terminal') {
    //   this.openTerminal();
    //   return;
    // }
    this.openToolList = this.openToolList.filter((e) => e !== name);
    this.openToolList.push(name);
    this.actionSubject.next({ action: 'open', type: 'tool', data: name });
  }

  // 如果其它组件/程序要关闭工具，调用这个方法
  closeTool(name: string) {
    if (name == 'terminal') {
      this.closeTerminal();
      return;
    }
    this.openToolList = this.openToolList.filter((e) => e !== name);
    this.actionSubject.next({ action: 'close', type: 'tool', data: name });
  }

  closeToolAll() {
    this.openToolList.forEach((name) => {
      this.closeTool(name);
    });
    this.openToolList = [];
  }

  // 发送工具信号，格式为 "toolname:action"，如 "serial-monitor:disconnect"
  sendToolSignal(signal: string) {
    this.actionSubject.next({ action: 'signal', type: 'tool', data: signal });
  }

  /**
   * 打开 aily-chat 面板并发送消息。
   * 标准接口：任何需要「代为向大模型发送消息」的场景，统一调用此方法。
   * aily-chat 模组内部订阅 chatMessage$ 处理，外部无需导入 aily-chat 的任何服务。
   *
   * @param text 要发送的文本内容
   * @param options 发送选项，如 { autoSend: true, cover: true }
   */
  openAndSendToChat(text: string, options?: Record<string, any>): void {
    console.warn('AI assistant is disabled in this build.');
  }

  // 判断某个工具是否打开
  isToolOpen(name: string): boolean {
    return this.openToolList.includes(name);
  }

  turnBottomSider(data = 'default') {
    if (this.terminalIsOpen && this.currentBottomTab === data) {
      // 如果底部面板已经打开且当前选中的就是要打开的tab，则关闭面板
      this.closeTerminal();
    } else if (this.terminalIsOpen) {
      // 如果底部面板已经打开但选中的不是要打开的tab，则切换到指定的tab
      this.switchBottomSiderTab(data);
    } else {
      // 如果底部面板未打开，则打开面板并显示指定的组件
      this.openBottomSider(data);
    }
  }

  // 切换底部面板的tab
  switchBottomSiderTab(data: string) {
    this.currentBottomTab = data;
    this.actionSubject.next({ action: 'switch-tab', type: 'bottom-sider', data });
  }

  async openBottomSider(data = 'default'): Promise<{ pid: number }> {
    this.currentBottomTab = data;
    this.actionSubject.next({ action: 'open', type: 'bottom-sider', data });
    this.terminalIsOpen = true;
    return { pid: 0 };
  }

  closeTerminal() {
    this.actionSubject.next({ action: 'close', type: 'bottom-sider' });
    this.terminalIsOpen = false;
    this.currentBottomTab = '';
  }

  // 更新footer右下角的状态
  updateFooterState(state: ActionState) {
    this.stateSubject.next(state);
  }

  // 关闭当前窗口
  closeWindow() {
    this.router.navigate(['/main/guide']);
  }



  openProjectSettings() {
    // 这里参考 USAGE_EXAMPLE.ts 中的代码实现
    const modalRef = this.modal.create({
      nzTitle: null,
      nzFooter: null,
      nzClosable: false,
      nzBodyStyle: {
        padding: '0',
      },
      nzContent: ProjectSettingDialogComponent,
      nzWidth: '520px',
    });

    // 处理反馈结果
    modalRef.afterClose.subscribe(result => {
      if (result?.result === 'success') {
        console.log('反馈已提交:', result.data);
      }
    });
  }
}

export interface WindowOpts {
  path: string;
  data?: any;
  title?: string;
  alwaysOnTop?: boolean;
  width?: number;
  height?: number;
  queryParams?: Record<string, any>;
}

export interface ToolOpts {
  type: string;
  data: string;
  title?: string;
}

export interface ActionState {
  text: string;
  desc?: string;
  state?: 'done' | 'doing' | 'error' | 'warn' | 'loading' | string,
  color?: string;
  icon?: string;
  timeout?: number;
}
