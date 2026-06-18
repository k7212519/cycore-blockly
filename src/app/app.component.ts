import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { RouterOutlet, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { ElectronService } from './services/electron.service';
import { ConfigService } from './services/config.service';
import { TranslationService } from './services/translation.service';
import { EdaAuthService } from './auth/eda-auth.service';
import { ThemeService } from './services/theme.service';

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
  title = 'CYCORE-MCU-DevCloud';

  private electronService = inject(ElectronService);
  private configService = inject(ConfigService);
  private translationService = inject(TranslationService);
  private edaAuthService = inject(EdaAuthService);
  private themeService = inject(ThemeService);
  private router = inject(Router);

  private exampleListListener: (() => void) | null = null;

  async ngOnInit() {
    await this.electronService.init();
    await this.configService.init();
    this.themeService.initialize();
    await this.translationService.init();
    await this.edaAuthService.initialize();

    if (!this.electronService.isElectron) return;
    // 设置示例列表监听器
    this.setupExampleListListener();

    // 通知主进程渲染进程已就绪
    this.electronService.sendRendererReady();
  }

  ngOnDestroy() {
    // 清理示例列表监听器
    if (this.exampleListListener) {
      this.exampleListListener();
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
