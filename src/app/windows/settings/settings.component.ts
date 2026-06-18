import { Component, ElementRef, ViewChild } from '@angular/core';
import { SubWindowComponent } from '../../components/sub-window/sub-window.component';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { UiService } from '../../services/ui.service';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { TranslationService } from '../../services/translation.service';
import { ConfigService } from '../../services/config.service';
import { SimplebarAngularModule } from 'simplebar-angular';
import { TranslateModule } from '@ngx-translate/core';
import { NzSwitchModule } from 'ng-zorro-antd/switch';
import { ActivatedRoute, Router } from '@angular/router';

@Component({
  selector: 'app-settings',
  imports: [
    CommonModule,
    FormsModule,
    SubWindowComponent,
    NzButtonModule,
    NzRadioModule,
    SimplebarAngularModule,
    TranslateModule,
    NzSwitchModule
  ],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  @ViewChild('scrollContainer', { static: false }) scrollContainer: ElementRef;

  activeSection = 'SETTINGS.SECTIONS.BASIC'; // 当前活动的部分

  // simplebar 配置选项
  options = {
    autoHide: true,
    scrollbarMinSize: 50
  };

  items = [
    {
      name: 'SETTINGS.SECTIONS.BASIC',
      icon: 'fa-light fa-gear'
    },
    {
      name: 'SETTINGS.SECTIONS.THEME',
      icon: 'fa-light fa-gift'
    },
    {
      name: 'SETTINGS.SECTIONS.BLOCKLY',
      icon: 'fa-light fa-puzzle-piece'
    },
  ];

  get langList() {
    return this.translationService.languageList;
  }

  get currentLang() {
    return this.translationService.getSelectedLanguage();
  }

  get configData() {
    return this.configService.data;
  }

  private returnUrl = '';

  constructor(
    private uiService: UiService,
    private translationService: TranslationService,
    private configService: ConfigService,
    private route: ActivatedRoute,
    private router: Router,
  ) {
  }

  async ngOnInit() {
    this.returnUrl = this.route.snapshot.queryParamMap.get('returnUrl') || '';
    await this.configService.init();
  }

  selectLang(lang) {
    this.translationService.setLanguage(lang.code);
    window['ipcRenderer'].send('setting-changed', { action: 'language-changed', data: lang.code });
  }

  // 使用锚点滚动到指定部分
  scrollToSection(item) {
    this.activeSection = item.name;
    const element = document.getElementById(item.name);
    if (element && this.scrollContainer) {
      // 针对simplebar调整滚动方法
      const simplebarInstance = this.scrollContainer['SimpleBar'];
      if (simplebarInstance) {
        simplebarInstance.getScrollElement().scrollTo({
          top: element.offsetTop - 12,
          behavior: 'smooth'
        });
      }
    }
  }

  // 监听滚动事件以更新活动菜单项
  onScroll() {
    const sections = document.querySelectorAll('.section');
    let scrollElement;

    // 获取simplebar的滚动元素
    const simplebarInstance = this.scrollContainer['SimpleBar'];
    if (simplebarInstance) {
      scrollElement = simplebarInstance.getScrollElement();
    } else {
      return;
    }

    const scrollPosition = scrollElement.scrollTop;

    sections.forEach((section: HTMLElement) => {
      const sectionTop = section.offsetTop;
      const sectionHeight = section.offsetHeight;

      if (scrollPosition >= sectionTop - 50 &&
        scrollPosition < sectionTop + sectionHeight - 50) {
        this.activeSection = section.id.replace('section-', '');
      }
    });
  }

  cancel() {
    this.closeOrReturn();
  }

  apply() {
    // 保存到config.json，如有需要立即加载的，再加载
    this.configService.save();
    // 保存完毕后关闭窗口或回到进入设置前的页面
    this.closeOrReturn();
  }

  private closeOrReturn() {
    if (this.returnUrl) {
      this.router.navigateByUrl(this.returnUrl);
      return;
    }
    this.uiService.closeWindow();
  }
}
