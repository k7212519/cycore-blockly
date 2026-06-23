import { DOCUMENT } from '@angular/common';
import { Inject, Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { ConfigService } from './config.service';

export type ThemeMode = 'dark' | 'light';

@Injectable({
  providedIn: 'root',
})
export class ThemeService {
  private static readonly STORAGE_KEY = 'cycore-ui-theme';
  private readonly themeSubject = new BehaviorSubject<ThemeMode>('dark');

  readonly theme$ = this.themeSubject.asObservable();

  get currentTheme(): ThemeMode {
    return this.themeSubject.value;
  }

  get isLight(): boolean {
    return this.currentTheme === 'light';
  }

  constructor(
    @Inject(DOCUMENT) private document: Document,
    private configService: ConfigService,
  ) {}

  initialize(): ThemeMode {
    const storedTheme = localStorage.getItem(ThemeService.STORAGE_KEY);
    const theme = this.normalize(storedTheme || this.configService.data?.theme);

    this.configService.data.theme = theme;
    this.applyTheme(theme);
    return theme;
  }

  preview(theme: unknown): ThemeMode {
    const normalized = this.normalize(theme);
    this.applyTheme(normalized);
    return normalized;
  }

  async confirm(theme: unknown): Promise<ThemeMode> {
    const normalized = this.preview(theme);
    this.configService.data.theme = normalized;

    localStorage.setItem(ThemeService.STORAGE_KEY, normalized);
    await this.configService.save();

    return normalized;
  }

  restore(theme: unknown): ThemeMode {
    return this.preview(theme);
  }

  normalize(theme: unknown): ThemeMode {
    return theme === 'light' ? 'light' : 'dark';
  }

  private applyTheme(theme: ThemeMode): void {
    const isLight = theme === 'light';
    const roots = [
      this.document.documentElement,
      this.document.body,
      this.document.querySelector('app-root'),
    ].filter((element): element is HTMLElement => !!element);

    roots.forEach((element) => {
      element.dataset['theme'] = theme;
      element.classList.toggle('llight', isLight);
      element.classList.toggle('ddark', !isLight);
    });

    this.document.documentElement.style.colorScheme = theme;
    this.swapZorroTheme(theme);

    if (this.themeSubject.value !== theme) {
      this.themeSubject.next(theme);
    }
  }

  private swapZorroTheme(theme: ThemeMode): void {
    const id = 'ng-zorro-theme';
    const href = `themes/ng-zorro-antd${theme === 'dark' ? '.dark' : '.min'}.css`;
    let link = this.document.getElementById(id) as HTMLLinkElement | null;

    if (!link) {
      link = this.document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      this.document.head.prepend(link);
    }

    if (link.getAttribute('href') !== href) {
      link.setAttribute('href', href);
    }
  }
}
