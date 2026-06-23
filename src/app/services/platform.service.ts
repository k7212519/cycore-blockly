import { Injectable } from '@angular/core';
import { UAParser } from 'ua-parser-js';

@Injectable({
  providedIn: 'root'
})
export class PlatformService {
  private parser: UAParser;
  private _platformSeparator: string | null = null;

  constructor() {
    this.parser = new UAParser();
  }

  get za7() {
    return this.isWindows() ? '7za.exe' : '7zz';
  }
  
  // 浏览器端不直接执行 7-Zip，仅保留工具名供服务端参数展示。
  async getZa7Path(): Promise<string> {
    return this.za7;
  }

  /**
   * 获取平台路径分隔符
   * @returns Windows 返回 '\\'，其他平台返回 '/'
   */
  getPlatformSeparator(): string {
    if (this._platformSeparator === null) {
      const os = this.parser.getOS();
      this._platformSeparator = this.isWindowsOS(os.name) ? '\\' : '/';
    }
    
    return this._platformSeparator;
  }

  /**
   * 检查是否为 Windows 操作系统
   */
  isWindows(): boolean {
    const os = this.parser.getOS();
    return this.isWindowsOS(os.name);
  }

  /**
   * 检查是否为 macOS 操作系统
   */
  isMac(): boolean {
    const os = this.parser.getOS();
    return os.name?.toLowerCase().includes('mac') || false;
  }

  /**
   * 检查是否为 Linux 操作系统
   */
  isLinux(): boolean {
    const os = this.parser.getOS();
    return os.name?.toLowerCase().includes('linux') || false;
  }

  /**
   * 获取操作系统信息
   */
  getOSInfo() {
    return this.parser.getOS();
  }

  /**
   * 获取浏览器信息
   */
  getBrowserInfo() {
    return this.parser.getBrowser();
  }

  isSafari(): boolean {
    const browser = this.parser.getBrowser();
    const name = browser.name?.toLowerCase() || '';
    return name.includes('safari') && !name.includes('chrome') && !name.includes('chromium');
  }

  isChromium(): boolean {
    const browser = this.parser.getBrowser();
    const name = browser.name?.toLowerCase() || '';
    return name.includes('chrome')
      || name.includes('chromium')
      || name.includes('edge')
      || name.includes('opera')
      || name.includes('samsung');
  }

  supportsWebSerial(): boolean {
    return typeof navigator !== 'undefined' && !!(navigator as any).serial;
  }

  /**
   * 检查操作系统名称是否为 Windows
   * @param osName 操作系统名称
   */
  private isWindowsOS(osName?: string): boolean {
    if (!osName) return false;
    return osName.toLowerCase().includes('windows');
  }
}
