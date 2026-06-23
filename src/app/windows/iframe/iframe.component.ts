import {
  Component,
  Inject,
  OnDestroy,
  Optional,
  OnInit,
  NgZone,
  Input,
} from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { NZ_MODAL_DATA } from 'ng-zorro-antd/modal';
import { ActivatedRoute } from '@angular/router';
import { ConnectionGraphService } from '../../services/connection-graph.service';
import { NoticeService } from '../../services/notice.service';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { NotificationComponent } from '../../components/notification/notification.component';
import { CommonModule } from '@angular/common';
import { WindowMessenger, connect, Connection } from 'penpal';
import { UiService } from '../../services/ui.service';
import { TranslateService } from '@ngx-translate/core';
import { Subject, takeUntil } from 'rxjs';
import { ThemeService } from '../../services/theme.service';

export interface IframeModalData {
  /** 要加载的 iframe URL */
  url: string;
  /** 传递给 iframe 页面的数据 */
  data?: unknown;
  /** 窗口标题 */
  title?: string;
  /** 嵌入式渲染，不显示独立页面外壳 */
  embedded?: boolean;
}

@Component({
  selector: 'app-iframe',
  imports: [SubWindowComponent, NotificationComponent, CommonModule],
  templateUrl: './iframe.component.html',
  styleUrl: './iframe.component.scss',
})
export class IframeComponent implements OnInit, OnDestroy {
  @Input() url?: string;
  @Input() embedded?: boolean;

  iframeSrc: SafeResourceUrl = '';
  private iframeData: unknown;
  private allowedOrigins: string[] = ['*'];

  // Penpal 连接
  private penpalConnection: Connection | null = null;
  private remoteApi: any = null;

  // 窗口标题
  windowTitle = '';

  // 无数据状态显示控制
  showEmptyState = false;
  // Loading 状态显示控制
  isLoading = true;
  /** 是否为 component-viewer 窗口 */
  isComponentViewerWindow = false;

  // ===== 连线图自动生成相关 =====
  /** 是否为连线图窗口 */
  isConnectionGraphWindow = false;
  private currentUrl = '';
  private destroy$ = new Subject<void>();

  constructor(
    @Optional() @Inject(NZ_MODAL_DATA) public data: IframeModalData | null,
    private sanitizer: DomSanitizer,
    private route: ActivatedRoute,
    private connectionGraphService: ConnectionGraphService,
    private noticeService: NoticeService,
    private ngZone: NgZone,
    private uiService: UiService,
    private translate: TranslateService,
    private themeService: ThemeService,
  ) {
    this.themeService.theme$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        if (this.currentUrl) {
          this.applyUrl(this.currentUrl);
        }
      });
    if (this.data) {
      if (this.data.url) {
        this.applyUrl(this.data.url);
      }
      if (this.data.data !== undefined) {
        this.iframeData = this.data.data;
      }
      if (this.data.title) {
        this.windowTitle = this.data.title;
      }
      if (this.data.embedded !== undefined) {
        this.embedded = this.data.embedded;
      }
    }
  }

  async ngOnInit() {
    // 延迟显示无数据状态（如果加载失败）
    setTimeout(() => {
      if (this.isLoading) {
        this.isLoading = false;
        this.showEmptyState = true;
      }
    }, 10000); // 10秒超时

    await new Promise((resolve) => setTimeout(resolve, 100));

    if (this.embedded) {
      this.applyUrl(this.url);
      return;
    }

    // 如果不是 modal 模式，从 URL 查询参数读取
    if (!this.data) {
      this.route.queryParams.subscribe((params) => {
        const url = params['url'];
        if (url) {
          this.applyUrl(url);
        }
      });

    }
  }

  /**
   * 统一应用 URL：设置 iframeSrc、allowedOrigins、isConnectionGraphWindow
   */
  private applyUrl(url: string): void {
    if (!url) {
      return;
    }
    this.currentUrl = url;
    const themedUrl = this.applyThemeParam(url);
    this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(themedUrl);
    try {
      this.allowedOrigins = [new URL(themedUrl).origin];
    } catch {
      this.allowedOrigins = ['*'];
    }
    if (url.includes('connection-graph')) {
      this.isConnectionGraphWindow = true;
    }
    if (url.includes('component-viewer')) {
      this.isComponentViewerWindow = true;
    }
  }

  private applyThemeParam(url: string): string {
    if (!url) {
      return url;
    }
    if (!url.includes('tool.aily.pro') && !url.includes('localhost:4201')) {
      return url;
    }
    try {
      const parsed = new URL(url);
      parsed.searchParams.set('theme', this.themeService.currentTheme);
      return parsed.toString();
    } catch {
      return url;
    }
  }

  /**
   * 处理来自 openWindow 传递的 IPC 初始化数据
   */
  private handleInitData(initData: any): void {
    console.log(
      '[IframeComponent] handleInitData received:',
      initData ? 'has data' : 'null',
    );
    if (!initData) return;

    if (initData.title) {
      this.windowTitle = initData.title;
    }

    if (initData.url) {
      this.applyUrl(initData.url);
    }

    this.iframeData = initData.data !== undefined ? initData.data : initData;
  }

  /**
   * iframe 加载完成后，使用 penpal 建立连接
   */
  onIframeLoad(event: Event): void {
    const iframe = event.target as HTMLIFrameElement;
    if (!iframe.contentWindow) {
      this.handleLoadError();
      return;
    }

    // 销毁旧连接，避免连接残留
    if (this.penpalConnection) {
      this.penpalConnection.destroy();
      this.penpalConnection = null;
      this.remoteApi = null;
    }

    this.startPenpalConnection(iframe);
  }

  /**
   * 使用 penpal 建立与 iframe 的双向通信
   */
  private async startPenpalConnection(
    iframe: HTMLIFrameElement,
  ): Promise<void> {
    try {
      const messenger = new WindowMessenger({
        remoteWindow: iframe.contentWindow!,
        allowedOrigins: this.allowedOrigins,
      });

      // 父窗口暴露给子页面的方法
      this.penpalConnection = connect({
        messenger,
        methods: {
          initedComponentViewer: () => {
            this.pushDataToRemote();
          },
          initedGraph: () => {
            this.pushDataToRemote();
          },
          generateGraphData: () => {
            this.noticeService.update({
              title: 'AI生成中',
              text: '正在生成连线图...',
              state: 'doing',
              showProgress: false,
            });
            // this.backgroundAgent.generateSchematic();
            // this.uiService.openAndSendToChat('@schematicAgent 生成项目连线图', { autoSend: true });
            this.sendToChat('@schematicAgent 生成项目连线图');
            // this.sendToMain('generate-graph-data');
          },
          regenerateGraphData: () => {
            this.onRegenerate();
          },
          generateGraphCode: () => {
            this.onSyncToCode();
          },
          saveGraphData: async (data) => {
            this.iframeData = data;
            return this.sendSaveGraphData(this.iframeData);
          },
          getGraphData: () => Promise.resolve(this.iframeData ?? null),
          // 子页面编辑连线后回调此方法，持久化更新
          onConnectionsChanged: (connections: any) => {
            try {
              if (connections && Array.isArray(connections)) {
                // 获取当前 payload 数据（包含 componentConfigs, components, connections）
                const currentPayload = this.iframeData as any;
                if (currentPayload && currentPayload.components) {
                  // 通过 IPC 让主窗口保存数据（子窗口无法直接访问 projectPath）
                  const updatedData = {
                    version: '1.0.0',
                    description: '',
                    components: currentPayload.components,
                    connections: connections,
                  };
                  this.sendSaveGraphData(updatedData).then(({ success }) => {
                    if (!success) {
                      this.ngZone.run(() =>
                        this.noticeService.update({
                          state: 'error',
                          text: this.translate.instant('AILY_CHAT.MERMAID_SAVE_FAILED'),
                        })
                      );
                    }
                  });
                  this.iframeData = {
                    ...currentPayload,
                    connections: connections,
                  };
                  console.log(
                    '[IframeComponent] 已发送保存请求:',
                    connections.length,
                  );
                }
              }
            } catch (e) {
              console.warn('onConnectionsChanged 持久化失败:', e);
            }
          },
          noticeUpdate: (notification: any) => {
            this.noticeService.update(notification);
          }
        },
      });

      const remote = await this.penpalConnection.promise;
      this.remoteApi = remote;

      // 将 remote API 注册到 ConnectionGraphService，供 Agent 工具推送数据
      this.connectionGraphService.setIframeApi(remote);

      // 连接成功，结束 loading
      this.isLoading = false;
      this.showEmptyState = false;

      // TODO:如果是 component-viewer 窗口，立即推送数据给子页面，新版本为web主动调用，这里临时多推送一次，待web更新后可删除
      if (this.isComponentViewerWindow) {
        setTimeout(() => {
          this.pushDataToRemote();
        }, 10);
      }
    } catch (error) {
      console.error('Penpal 连接失败:', error);
      // 连接失败时降级：使用 postMessage 发送数据
      this.isLoading = false;
      this.showEmptyState = false;
    }
  }

  /**
   * 发送保存请求并等待主窗口返回结果
   */
  private async sendSaveGraphData(data: unknown): Promise<{ success: boolean }> {
    const toSave = this.toConnectionGraphData(data);
    if (!toSave) {
      return { success: false };
    }

    const success = await this.connectionGraphService.saveConnectionGraphSilentAsync(toSave);
    return { success };
  }

  private toConnectionGraphData(data: unknown): any | null {
    const source = data as any;
    if (!source || !Array.isArray(source.components) || !Array.isArray(source.connections)) {
      return null;
    }

    return {
      version: source.version || '1.0.0',
      description: source.description || '',
      components: source.components,
      connections: source.connections,
    };
  }

  /**
   * 推送数据给已连接的子页面（penpal 方式）
   */
  private async pushDataToRemote(): Promise<void> {
    if (!this.remoteApi) return;
    try {
      if (typeof this.remoteApi['receiveData'] === 'function') {
        await (
          this.remoteApi['receiveData'] as (data: unknown) => Promise<void>
        )(this.iframeData);
      }
    } catch (error) {
      console.warn('推送数据给子页面失败:', error);
    }
  }

  /**
   * 处理加载错误
   */
  handleLoadError(): void {
    this.isLoading = false;
    this.showEmptyState = true;
  }

  /**
   * 调用子页面暴露的远程方法
   */
  async callRemote(method: string, ...args: any[]): Promise<any> {
    if (!this.remoteApi || typeof this.remoteApi[method] !== 'function') {
      console.warn(`远程方法 ${method} 不可用`);
      return null;
    }
    return this.remoteApi[method](...args);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    // 清除 ConnectionGraphService 中的 iframe API 引用
    this.connectionGraphService.clearIframeApi();
    if (this.penpalConnection) {
      this.penpalConnection.destroy();
      this.penpalConnection = null;
    }
  }

  // =====================================================
  // connection-graph IPC 消息处理
  // =====================================================

  /**
   * 处理连线图全量更新
   */
  private async handleConnectionGraphUpdate(data: any): Promise<void> {
    if (!data) return;
    try {
      // 使用 IPC 发送过来的完整 payload（包含最新的 componentConfigs）
      const currentPayload = this.iframeData as any;
      const newPayload = {
        // 优先使用新的 componentConfigs，如果没有则保留旧的
        componentConfigs:
          data.componentConfigs || currentPayload?.componentConfigs || {},
        components: data.components || [],
        connections: data.connections || [],
        theme: data.theme || currentPayload?.theme || this.themeService.currentTheme,
      };
      this.iframeData = newPayload;
      await this.pushDataToRemote();
      this.noticeService.update({
        title: 'AI生成中',
        text: '连线图已自动更新',
        state: 'done',
        setTimeout: 3000,
      });
    } catch (error) {
      console.error('[IframeComponent] 处理连线图更新失败:', error);
    }
  }

  // =====================================================
  // 操作按钮
  // =====================================================

  /**
   * 向 aily-chat 发送消息。
   * 直接调用主窗口内的聊天服务。
   */
  private sendToChat(text: string): void {
    this.uiService.openAndSendToChat(text, { autoSend: true });
  }

  /**
   * 操作按钮: 重新生成
   */
  onRegenerate(): void {
    this.noticeService.update({
      title: 'AI生成中',
      text: '正在重新生成连线图...',
      state: 'doing',
      showProgress: false,
    });
    this.sendToChat('@schematicAgent 请根据当前项目的引脚配置和组件信息，重新生成连线图方案。');
  }

  /**
   * 操作按钮: 同步到代码
   */
  onSyncToCode(): void {
    this.noticeService.update({
      title: 'AI生成中',
      text: '正在同步连线配置到代码，请在对话框中查看进度...',
      state: 'doing',
      showProgress: false,
    });
    this.sendToChat('请根据当前连线图方案，将硬件连线配置同步到项目代码中。');
  }
}
