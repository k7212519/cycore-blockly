import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class BrowserService {
  private static readonly FILE_PREFIX = 'cycore-browser-file:';

  openUrl(url: string): void {
    if (url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  setTitle(title: string): void {
    document.title = title;
  }

  openNewInStance(route: string, queryParams?: Record<string, unknown> | null): void {
    const tree = new URLSearchParams();
    Object.entries(queryParams || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        tree.set(key, String(value));
      }
    });
    const query = tree.toString();
    window.open(`#${route}${query ? `?${query}` : ''}`, '_blank', 'noopener,noreferrer');
  }

  async notify(title: string, body: string): Promise<{ success: boolean; error?: string }> {
    if (!('Notification' in window)) {
      return { success: false, error: '当前浏览器不支持系统通知' };
    }
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (Notification.permission !== 'granted') {
      return { success: false, error: '系统通知权限未授权' };
    }
    new Notification(title, { body });
    return { success: true };
  }

  isNotificationSupported(): Promise<boolean> {
    return Promise.resolve('Notification' in window);
  }

  isWindowFocused(): boolean {
    return document.hasFocus();
  }

  isWindowMinimized(): boolean {
    return document.visibilityState === 'hidden';
  }

  onWindowFocus(callback: () => void): () => void {
    window.addEventListener('focus', callback);
    return () => window.removeEventListener('focus', callback);
  }

  onWindowBlur(callback: () => void): () => void {
    window.addEventListener('blur', callback);
    return () => window.removeEventListener('blur', callback);
  }

  isWindowMaximized(): boolean {
    return false;
  }

  isWindowFullScreen(): boolean {
    return document.fullscreenElement !== null;
  }

  onWindowFullScreenChanged(callback: (isFullScreen: boolean) => void): () => void {
    const handler = () => callback(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }

  onWindowMaximizeChanged(_callback: (isMaximized: boolean) => void): () => void {
    return () => {};
  }

  pathJoin(...parts: string[]): string {
    return parts
      .filter(Boolean)
      .join('/')
      .replace(/\/+/g, '/')
      .replace(/\/\.\//g, '/');
  }

  exists(path: string): boolean {
    return localStorage.getItem(this.storageKey(path)) !== null;
  }

  readFile(path: string): string {
    const content = localStorage.getItem(this.storageKey(path));
    if (content === null) {
      throw new Error(`浏览器存储中不存在文件: ${path}`);
    }
    return content;
  }

  readDir(path: string): Array<{ name: string; parentPath: string; path: string }> {
    const prefix = `${this.storageKey(path).replace(/\/$/, '')}/`;
    const names = new Set<string>();
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const relative = key.slice(prefix.length);
      const name = relative.split('/')[0];
      if (name) names.add(name);
    }
    return Array.from(names).map(name => ({
      name,
      parentPath: path,
      path: this.pathJoin(path, name),
    }));
  }

  writeFile(path: string, content: string): void {
    localStorage.setItem(this.storageKey(path), content);
  }

  deleteFile(path: string): void {
    localStorage.removeItem(this.storageKey(path));
  }

  deleteDir(path: string): void {
    const prefix = `${this.storageKey(path).replace(/\/$/, '')}/`;
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    keys.forEach(key => localStorage.removeItem(key));
  }

  openByExplorer(_path: string): void {
    console.warn('浏览器无法打开系统文件管理器');
  }

  async calculateHash(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  private storageKey(path: string): string {
    return `${BrowserService.FILE_PREFIX}${this.pathJoin(path)}`;
  }
}
