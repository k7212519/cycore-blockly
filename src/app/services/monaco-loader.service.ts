import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class MonacoLoaderService {
  private document = inject(DOCUMENT);
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

        win.require.config({ paths: { vs: 'assets/vs' } });
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
}
