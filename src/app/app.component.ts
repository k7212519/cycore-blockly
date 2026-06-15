import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { RouterOutlet, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { ElectronService } from './services/electron.service';
import { ConfigService } from './services/config.service';
import { TranslationService } from './services/translation.service';
import { AuthService } from './services/auth.service';
import { ThemeService } from './services/theme.service';
import { ProjectService } from './services/project.service';
import { NzMessageService } from 'ng-zorro-antd/message';
import { TranslateService } from '@ngx-translate/core';
import { resolveTranslatedApiErrorMessage } from './utils/api-error.utils';
import { ToolI18nService } from './services/tool-i18n.service';

// 声明 electronAPI 类型
declare const window: any;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'aily-blockly';

  private electronService = inject(ElectronService);
  private configService = inject(ConfigService);
  private translationService = inject(TranslationService);
  private authService = inject(AuthService);
  private themeService = inject(ThemeService);
  private projectService = inject(ProjectService);
  private message = inject(NzMessageService);
  private router = inject(Router);
  private translate = inject(TranslateService);
  private toolI18n = inject(ToolI18nService);

  private oauthResultListener: (() => void) | null = null;
  private exampleListListener: (() => void) | null = null;
  private projectStateSubscription: Subscription | null = null;
  private startupLoadingHideTimer: ReturnType<typeof setTimeout> | null = null;
  private startupLoadingMaxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private startupLoadingObservedProjectLoad = false;
  private startupLoadingHidden = false;

  async ngOnInit() {
    this.watchStartupLoadingState();

    await this.electronService.init();
    await this.configService.init();
    this.themeService.init();
    await this.translationService.init();
    await this.toolI18n.loadChildTools();

    // 在ElectronService初始化完成后再初始化认证服务
    await this.authService.initializeAuth();

    if (!this.electronService.isElectron) {
      this.scheduleInitialStartupLoadingHide();
      return;
    }

    // 设置全局OAuth监听器
    this.setupGlobalOAuthListener();
    // 设置示例列表监听器
    this.setupExampleListListener();

    // 通知主进程渲染进程已就绪
    this.electronService.sendRendererReady();
    this.scheduleInitialStartupLoadingHide();
  }

  ngOnDestroy() {
    this.projectStateSubscription?.unsubscribe();
    this.clearStartupLoadingTimers();

    // 清理OAuth监听器
    if (this.oauthResultListener) {
      this.oauthResultListener();
    }
    // 清理示例列表监听器
    if (this.exampleListListener) {
      this.exampleListListener();
    }
  }

  private watchStartupLoadingState() {
    this.projectStateSubscription = this.projectService.stateSubject.subscribe((state) => {
      if (state === 'loading') {
        this.startupLoadingObservedProjectLoad = true;
        this.clearStartupLoadingHideTimer();
        this.ensureStartupLoadingMaxWait();
        return;
      }

      if (state === 'loaded' || state === 'error') {
        this.startupLoadingObservedProjectLoad = true;
        this.scheduleStartupLoadingHide(120);
      }
    });
  }

  private scheduleInitialStartupLoadingHide() {
    this.clearStartupLoadingHideTimer();
    this.startupLoadingHideTimer = setTimeout(() => {
      if (this.startupLoadingHidden || this.projectService.stateSubject.value === 'loading') {
        return;
      }

      if (this.isInitialProjectEditorRoute() && !this.startupLoadingObservedProjectLoad) {
        this.ensureStartupLoadingMaxWait();
        return;
      }

      this.hideStartupLoading();
    }, 300);
  }

  private isInitialProjectEditorRoute(): boolean {
    const url = this.router.url || window.location.hash || window.location.href;
    return /\/main\/(blockly-editor|code-editor)(\?|$)/.test(url) && url.includes('path=');
  }

  private scheduleStartupLoadingHide(delay = 0) {
    this.clearStartupLoadingHideTimer();
    this.startupLoadingHideTimer = setTimeout(() => {
      this.hideStartupLoading();
    }, delay);
  }

  private hideStartupLoading() {
    if (this.startupLoadingHidden) {
      return;
    }

    const loadingBox = document.getElementById('app-loading-box');
    if (!loadingBox) {
      this.startupLoadingHidden = true;
      this.clearStartupLoadingTimers();
      return;
    }

    this.startupLoadingHidden = true;
    loadingBox.classList.add('loading-box--hidden');
    setTimeout(() => loadingBox.remove(), 220);
    this.clearStartupLoadingTimers();
  }

  private ensureStartupLoadingMaxWait() {
    if (this.startupLoadingMaxWaitTimer || this.startupLoadingHidden) {
      return;
    }

    this.startupLoadingMaxWaitTimer = setTimeout(() => {
      this.hideStartupLoading();
    }, 60000);
  }

  private clearStartupLoadingTimers() {
    this.clearStartupLoadingHideTimer();
    if (this.startupLoadingMaxWaitTimer) {
      clearTimeout(this.startupLoadingMaxWaitTimer);
      this.startupLoadingMaxWaitTimer = null;
    }
  }

  private clearStartupLoadingHideTimer() {
    if (this.startupLoadingHideTimer) {
      clearTimeout(this.startupLoadingHideTimer);
      this.startupLoadingHideTimer = null;
    }
  }

  /**
   * 设置全局GitHub OAuth协议回调监听
   */
  private setupGlobalOAuthListener() {
    if (window['oauth'] && window['oauth'].onCallback) {
      this.oauthResultListener = window['oauth'].onCallback(async (callbackData: any) => {
        try {
          // 使用AuthService处理协议回调
          const result = await this.authService.handleOAuthCallback(callbackData);

          if (result.success) {
            // console.log('GitHub OAuth 成功:', result.data);
            this.message.success('GitHub 登录成功');
          } else {
            // OAuth失败
            let errorMessage = 'GitHub 登录超时，请重试';

            switch (result.error) {
              case 'needs_wechat_bind':
                // 需要绑定微信，通知登录组件
                this.authService.emitNeedsWechatBind(result.data?.pending_ticket);
                return;
              case 'timeout':
              case 'invalid_state':
                errorMessage = '登录状态无效或已超时，请重试';
                break;
              case 'missing_parameters':
                errorMessage = '授权参数缺失，请重试';
                break;
              case 'access_denied':
                errorMessage = '您取消了授权';
                break;
              case 'callback_processing_failed':
                errorMessage = resolveTranslatedApiErrorMessage(result, this.translate, {
                  fallbackMessage: result.message || '处理授权回调失败',
                });
                break;
              default:
                errorMessage = resolveTranslatedApiErrorMessage(result, this.translate, {
                  fallbackMessage: result.message || 'GitHub 登录超时，请重试',
                });
            }

            this.message.error(errorMessage);
          }
        } catch (error) {
          console.error('处理OAuth回调异常:', error);
          this.message.error(resolveTranslatedApiErrorMessage(error, this.translate, {
            fallbackMessage: '登录处理失败，请重试',
          }));
        }
      });
    }
  }

  /**
   * 设置示例列表协议监听
   */
  private setupExampleListListener() {
    if (window['exampleList'] && window['exampleList'].onOpen) {
      this.exampleListListener = window['exampleList'].onOpen((data: any) => {
        console.log('收到打开示例列表请求:', data);
        
        // 导航到示例列表页面
        this.router.navigate(['/main/playground'], {
          queryParams: { 
            keyword: data.keyword || '',
            id: data.id || '',
            sessionId: data.sessionId || '',
            params: data.params || '',
            version: data.version || ''
          }
        });
      });
    }
  }
}
