import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { ConfigService } from './config.service';

@Injectable({
  providedIn: 'root'
})
export class MonacoLoaderService {
  private document = inject(DOCUMENT);
  private configService = inject(ConfigService);
  private loadPromise?: Promise<void>;

  load(): Promise<void> {
    if ((globalThis as any).monaco?.editor) {
      this.disableAmdCompatibilityFlag();
      return Promise.resolve();
    }

    this.loadPromise ||= this.loadFromAssets();
    return this.loadPromise;
  }

  private loadFromAssets(): Promise<void> {
    return new Promise((resolve, reject) => {
      const win = globalThis as any;
      const loadEditor = () => {
        if (!win.require?.config) {
          reject(new Error('Monaco loader is not ready'));
          return;
        }

        win.require.config({
          paths: { vs: 'assets/vs' },
          'vs/nls': {
            availableLanguages: {
              '*': this.getMonacoLanguage()
            }
          }
        });
        win.require(
          ['vs/editor/editor.main'],
          () => {
            this.disableAmdCompatibilityFlag();
            resolve();
          },
          reject
        );
      };

      if (win.require?.config) {
        loadEditor();
        return;
      }

      const script = this.document.createElement('script');
      script.type = 'text/javascript';
      script.src = 'assets/vs/loader.js';
      script.onload = loadEditor;
      script.onerror = () => reject(new Error('Monaco loader failed to load'));
      this.document.documentElement.appendChild(script);
    });
  }

  private disableAmdCompatibilityFlag(): void {
    const define = (globalThis as any).define;
    if (typeof define === 'function' && define.amd) {
      define.amd = false;
    }
  }

  private getMonacoLanguage(): 'zh-cn' | 'zh-tw' | 'en' {
    const lang = (this.configService.data?.selectedLanguage || this.configService.data?.lang || '')
      .toLowerCase()
      .replace('_', '-');

    if (lang === 'zh-hk' || lang === 'zh-tw' || lang === 'zh-hant') {
      return 'zh-tw';
    }
    if (lang === 'en' || lang.startsWith('en-')) {
      return 'en';
    }
    return 'zh-cn';
  }
}
