import { CommonModule } from '@angular/common';
import { Component, effect, Input, NgZone, OnChanges, OnDestroy, OnInit, SimpleChanges } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { NzToolTipModule } from 'ng-zorro-antd/tooltip';
import { Connection, WindowMessenger, connect } from 'penpal';
import { Subscription } from 'rxjs';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { ChildToolConfig, getChildToolConfig } from '../../configs/tool.config';
import { ChildToolHostInfo, ChildToolProcessService } from '../../services/child-tool-process.service';
import { ThemeService } from '../../services/theme.service';
import { ToolI18nService } from '../../services/tool-i18n.service';
import { UiService } from '../../services/ui.service';

type HostStatus = 'idle' | 'starting' | 'ready' | 'error' | 'closed';

@Component({
  selector: 'app-child-tool-host',
  imports: [
    CommonModule,
    TranslateModule,
    NzToolTipModule,
    SubWindowComponent,
    ToolContainerComponent
  ],
  templateUrl: './child-tool-host.component.html',
  styleUrl: './child-tool-host.component.scss'
})
export class ChildToolHostComponent implements OnInit, OnChanges, OnDestroy {
  @Input() toolId = '';

  currentUrl = '';
  resolvedToolId = '';
  titleKey = '';
  routePath = '';
  hostStatus: HostStatus = 'idle';
  iframeSrc: SafeResourceUrl | null = null;
  frameLoaded = false;
  errorMessage = '';
  serverInfo: ChildToolHostInfo | null = null;

  private config: ChildToolConfig | null = null;
  private initialized = false;
  private acquired = false;
  private penpalConnection: Connection | null = null;
  private remoteApi: any = null;
  private childReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private langSubscription: Subscription | null = null;
  private toolSignalSubscription: Subscription | null = null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private uiService: UiService,
    private toolI18n: ToolI18nService,
    private sanitizer: DomSanitizer,
    private processService: ChildToolProcessService,
    private ngZone: NgZone,
    private translate: TranslateService,
    private themeService: ThemeService
  ) {
    this.langSubscription = this.translate.onLangChange.subscribe(() => this.pushHostContext());
    effect(() => {
      this.themeService.theme();
      this.pushHostContext();
    });
  }

  get isStandalone(): boolean {
    return this.currentUrl.startsWith('/child-tool/');
  }

  get backendStartingKey(): string {
    return this.key('BACKEND_STARTING');
  }

  get backendFailedKey(): string {
    return this.key('BACKEND_FAILED');
  }

  ngOnInit(): void {
    this.initialized = true;
    this.toolSignalSubscription = this.uiService.actionSubject.subscribe((action: any) => this.forwardToolSignal(action));
    void this.initTool();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (this.initialized && changes['toolId'] && !changes['toolId'].firstChange) {
      void this.initTool();
    }
  }

  ngOnDestroy(): void {
    this.langSubscription?.unsubscribe();
    this.langSubscription = null;
    this.toolSignalSubscription?.unsubscribe();
    this.toolSignalSubscription = null;
    this.destroyPenpalConnection();
    if (this.acquired && this.resolvedToolId) {
      void this.processService.release(this.resolvedToolId);
      this.acquired = false;
    }
  }

  close(): void {
    if (this.resolvedToolId) {
      this.uiService.closeTool(this.resolvedToolId);
    }
  }

  async restart(): Promise<void> {
    if (!this.config) return;

    this.destroyPenpalConnection();
    this.serverInfo = null;
    this.iframeSrc = null;
    this.frameLoaded = false;
    this.hostStatus = 'closed';
    await this.startServer(true);
  }

  onFrameLoad(event: Event): void {
    const iframe = event.target as HTMLIFrameElement;
    this.log('iframe load', {
      url: this.sanitizeUrl(this.serverInfo?.url),
      hasContentWindow: !!iframe.contentWindow
    });

    if (!iframe.contentWindow) {
      this.hostStatus = 'error';
      this.errorMessage = `${this.resolvedToolId} iframe did not expose contentWindow`;
      this.logError('iframe missing contentWindow', this.errorMessage);
      return;
    }

    this.startPenpalConnection(iframe);
  }

  private async initTool(): Promise<void> {
    const nextToolId = this.resolveToolId();
    if (!nextToolId) {
      this.showConfigError('Child tool id is missing');
      return;
    }

    this.log('init', {
      inputToolId: this.toolId,
      routeToolId: this.route.snapshot.paramMap.get('toolId'),
      resolvedToolId: nextToolId,
      currentUrl: this.router.url
    });

    if (this.acquired && this.resolvedToolId && this.resolvedToolId !== nextToolId) {
      await this.processService.release(this.resolvedToolId);
      this.acquired = false;
    }

    const config = getChildToolConfig(nextToolId);
    if (!config) {
      this.showConfigError(`Child tool is not registered: ${nextToolId}`);
      return;
    }

    this.config = config;
    this.resolvedToolId = config.id;
    this.titleKey = config.titleKey;
    this.routePath = config.routePath || `/child-tool/${config.id}`;
    this.currentUrl = this.router.url;

    this.log('config loaded', {
      id: config.id,
      childDir: config.childDir,
      entry: config.entry || 'index.js',
      uiIndex: config.uiIndex || 'ui/index.html',
      requiredDependencies: config.requiredDependencies || []
    });

    await this.toolI18n.load(config.id);
    this.log('i18n loaded');
    await this.startServer(false);
  }

  private async startServer(restart: boolean): Promise<void> {
    if (!this.config) return;
    if (!restart && (this.hostStatus === 'starting' || this.hostStatus === 'ready')) {
      return;
    }

    this.hostStatus = 'starting';
    this.errorMessage = '';
    this.frameLoaded = false;
    this.destroyPenpalConnection();
    this.log(restart ? 'restart server' : 'start server');

    try {
      this.serverInfo = restart
        ? await this.processService.restart(this.config.id)
        : await this.processService.acquire(this.config.id);
      this.acquired = true;
      const childToolUrl = this.buildChildToolUrl(this.serverInfo.url);
      this.log('server acquired', this.sanitizeHostInfo(this.serverInfo));
      this.log('iframe url prepared', this.sanitizeUrl(childToolUrl));
      this.iframeSrc = this.sanitizer.bypassSecurityTrustResourceUrl(childToolUrl);
      this.hostStatus = 'ready';
    } catch (error) {
      this.hostStatus = 'error';
      this.errorMessage = error instanceof Error ? error.message : String(error || '');
      this.logError('start failed', this.errorMessage);
    }
  }

  private startPenpalConnection(iframe: HTMLIFrameElement): void {
    this.destroyPenpalConnection();

    const allowedOrigin = this.serverInfo?.origin || this.resolveOrigin(this.serverInfo?.url);
    this.log('penpal connect', {
      allowedOrigin: allowedOrigin || '*',
      iframeUrl: this.sanitizeUrl(this.serverInfo?.url)
    });

    const messenger = new WindowMessenger({
      remoteWindow: iframe.contentWindow!,
      allowedOrigins: allowedOrigin ? [allowedOrigin] : ['*']
    });

    this.childReadyTimer = setTimeout(() => {
      if (!this.frameLoaded) {
        this.ngZone.run(() => {
          this.hostStatus = 'error';
          this.errorMessage = `${this.resolvedToolId} UI did not report ready`;
          this.logError('child ready timeout', this.errorMessage);
        });
      }
    }, 10000);

    this.penpalConnection = connect({
      messenger,
      methods: {
        getHostContext: () => this.createHostContext(),
        childReady: (payload: any) => {
          this.ngZone.run(() => {
            this.log('child ready', payload || {});
            this.frameLoaded = true;
            this.hostStatus = 'ready';
            this.errorMessage = '';
            if (payload?.pid && this.serverInfo) {
              this.serverInfo = { ...this.serverInfo, pid: Number(payload.pid) || this.serverInfo.pid };
            }
            this.clearChildReadyTimer();
          });
        },
        childError: (error: any) => {
          this.ngZone.run(() => {
            this.hostStatus = 'error';
            this.errorMessage = error?.message || String(error || `${this.resolvedToolId} child error`);
            this.logError('child error', this.errorMessage);
            this.clearChildReadyTimer();
          });
        },
        requestClose: () => {
          this.ngZone.run(() => this.close());
        },
        requestRestart: () => {
          this.ngZone.run(() => {
            void this.restart();
          });
        },
        openExternal: (url: string) => {
          (window as any).electronAPI?.other?.openByBrowser?.(url);
        },
        sendToolSignal: async (signal: string, payload: any = {}) => {
          return await this.sendToolSignalFromChild(signal, payload);
        }
      }
    });

    void this.penpalConnection.promise
      .then(remote => {
        this.log('penpal connected');
        this.remoteApi = remote;
        this.pushHostContext();
      })
      .catch(error => {
        this.ngZone.run(() => {
          this.hostStatus = 'error';
          this.errorMessage = error instanceof Error ? error.message : String(error || 'Penpal connection failed');
          this.logError('penpal failed', this.errorMessage);
          this.clearChildReadyTimer();
        });
      });
  }

  private destroyPenpalConnection(): void {
    this.clearChildReadyTimer();
    this.remoteApi = null;
    if (this.penpalConnection) {
      this.penpalConnection.destroy();
      this.penpalConnection = null;
    }
  }

  private clearChildReadyTimer(): void {
    if (this.childReadyTimer) {
      clearTimeout(this.childReadyTimer);
      this.childReadyTimer = null;
    }
  }

  private pushHostContext(): void {
    if (!this.remoteApi?.setHostContext) {
      return;
    }

    void Promise.resolve(this.remoteApi.setHostContext(this.createHostContext())).catch(() => undefined);
  }

  private forwardToolSignal(action: any): void {
    if (!this.remoteApi?.handleToolSignal) return;
    if (action?.action !== 'signal' || action?.type !== 'tool') return;
    if (action?.payload?.source === this.childSignalSource()) return;

    const task = Promise.resolve(this.remoteApi.handleToolSignal({
      action: action.action,
      type: action.type,
      data: action.data,
      payload: this.cloneSignalPayload(action.payload)
    })).then(() => undefined).catch(() => undefined);

    if (Array.isArray(action?.payload?.waitFor)) {
      action.payload.waitFor.push(task);
    }
  }

  private async sendToolSignalFromChild(signal: string, payload: any = {}): Promise<{ ok: boolean; waitFor: number }> {
    const waitFor: Promise<void>[] = [];
    const nextPayload = {
      ...(payload || {}),
      source: payload?.source || this.childSignalSource()
    };

    if (signal === 'serial-monitor:disconnect') {
      nextPayload.waitFor = waitFor;
    }

    this.uiService.sendToolSignal(signal, nextPayload);

    if (waitFor.length) {
      await Promise.all(waitFor);
    }

    if (signal === 'serial-monitor:disconnect') {
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    return { ok: true, waitFor: waitFor.length };
  }

  private cloneSignalPayload(payload: any): any {
    if (!payload || typeof payload !== 'object') return payload || {};
    const { waitFor: _waitFor, ...rest } = payload;
    return rest;
  }

  private childSignalSource(): string {
    return `child-tool:${this.resolvedToolId || this.toolId || 'unknown'}`;
  }

  private buildChildToolUrl(url: string): string {
    const context = this.createHostContext();

    try {
      const nextUrl = new URL(url);
      nextUrl.searchParams.set('lang', context['lang']);
      nextUrl.searchParams.set('theme', context['theme']);
      return nextUrl.toString();
    } catch {
      const separator = url.includes('?') ? '&' : '?';
      const query = new URLSearchParams({
        lang: context['lang'],
        theme: context['theme']
      });
      return `${url}${separator}${query.toString()}`;
    }
  }

  private createHostContext(): Record<string, string> {
    return {
      toolId: this.resolvedToolId,
      lang: this.normalizeLang(this.translate.currentLang || this.translate.defaultLang || 'en'),
      theme: this.normalizeTheme(this.themeService.theme()),
      platform: (window as any).electronAPI?.platform?.type || 'browser'
    };
  }

  private normalizeLang(lang: string): string {
    const normalized = String(lang || 'en').trim().toLowerCase().replace(/-/g, '_');
    if (normalized === 'zh' || normalized.startsWith('zh_cn')) return 'zh_cn';
    if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
    return normalized || 'en';
  }

  private normalizeTheme(theme: string): 'light' | 'dark' {
    return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
  }

  private resolveToolId(): string {
    return this.toolId || this.route.snapshot.paramMap.get('toolId') || this.route.snapshot.data['childToolId'] || '';
  }

  private resolveOrigin(url?: string): string {
    if (!url) return '';
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  private key(name: string): string {
    return this.config?.namespace ? `${this.config.namespace}.${name}` : name;
  }

  private showConfigError(message: string): void {
    this.hostStatus = 'error';
    this.errorMessage = message;
    this.titleKey = 'MENU.TOOL';
    this.routePath = '';
    this.logError('config error', message);
  }

  private log(stage: string, details?: any): void {
    console.info(`[child-tool-host:${this.resolvedToolId || this.toolId || 'unknown'}] ${stage}`, details ?? '');
  }

  private logError(stage: string, details?: any): void {
    console.error(`[child-tool-host:${this.resolvedToolId || this.toolId || 'unknown'}] ${stage}`, details ?? '');
  }

  private sanitizeHostInfo(info: ChildToolHostInfo | null): any {
    if (!info) return info;

    return {
      ...info,
      url: this.sanitizeUrl(info.url),
      wsUrl: this.sanitizeUrl(info.wsUrl),
      shutdownUrl: this.sanitizeUrl(info.shutdownUrl)
    };
  }

  private sanitizeUrl(url: any): any {
    if (typeof url !== 'string' || !url) return url;

    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has('token')) {
        parsed.searchParams.set('token', '<redacted>');
      }
      return parsed.toString();
    } catch {
      return url.replace(/([?&]token=)[^&]+/g, '$1<redacted>');
    }
  }
}
