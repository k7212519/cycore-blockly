import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { HttpClient } from '@angular/common/http';
import { lastValueFrom } from 'rxjs';
import { ConfigService } from './config.service';
import { ElectronService } from './electron.service';

export interface Locale {
  name: string;
  code: string;
  data?: Object;
}

@Injectable({
  providedIn: 'root'
})
export class TranslationService {
  private readonly supportedLanguages = ['zh_cn', 'zh_hk', 'en'];
  languageList: Locale[] = [];

  // 记录已加载的语言
  private loadedLanguages: Set<string> = new Set();

  constructor(
    private translate: TranslateService,
    private http: HttpClient,
    private configService: ConfigService,
    private electronService: ElectronService
  ) {
  }

  async init() {
    // 只获取语言列表，不预加载翻译数据
    await this.getLanguageList();

    // 设置默认语言
    const defaultLang = this.getSystemLanguage();
    this.translate.setDefaultLang(defaultLang);

    // 加载并设置当前选择的语言
    const currentLang = this.getSelectedLanguage();
    await this.setLanguage(currentLang);

    if (!this.electronService.isElectron) return;
    window['ipcRenderer'].on('setting-changed', (event, data) => {
      if (data.action == 'language-changed') {
        this.setLanguage(data.data);
      }
    });
  }

  async getLanguageList() {
    const languages = await lastValueFrom(
      this.http.get('i18n/i18n.json', {
        responseType: 'json',
      }),
    ) as Locale[];
    this.languageList = languages.filter(language =>
      this.supportedLanguages.includes(language.code)
    );
    return this.languageList;
  }

  async getLanguageData(lang: string) {
    // 从对应的语言文件夹加载翻译数据
    try {
      const languageData = await lastValueFrom(
        this.http.get(`i18n/${lang}/${lang}.json`, {
          responseType: 'json',
        }),
      );
      return languageData;
    } catch (error) {
      console.error(`Failed to load language data for ${lang}:`, error);
      return {};
    }
  }

  getSystemLanguage(): string {
    const language = navigator.language || (navigator.languages && navigator.languages[0]);
    return this.normalizeLanguage(language);
  }

  async setLanguage(lang: string) {
    lang = this.normalizeLanguage(lang);
    // 检查该语言是否已加载
    if (!this.loadedLanguages.has(lang)) {
      // 如果未加载，先加载语言数据
      const languageData = await this.getLanguageData(lang);
      this.translate.setTranslation(lang, languageData);
      this.loadedLanguages.add(lang);
    }

    // 使用该语言
    this.translate.use(lang);
    this.configService.data['selectedLanguage'] = lang;
    this.configService.save();
    return lang;
  }

  getSelectedLanguage() {
    return this.normalizeLanguage(
      this.configService.data?.selectedLanguage || this.translate.getDefaultLang()
    );
  }

  private normalizeLanguage(lang?: string): string {
    const normalized = (lang || '').toLowerCase().replace('-', '_');
    if (normalized === 'zh_hk' || normalized === 'zh_tw' || normalized === 'zh_hant') {
      return 'zh_hk';
    }
    if (normalized === 'en' || normalized.startsWith('en_')) {
      return 'en';
    }
    return 'zh_cn';
  }
}
