import { Injectable } from '@angular/core';

/**
 * 浏览器构建不提供本机文件系统操作。
 * 服务端项目流程不应调用本服务；调用时直接给出明确错误。
 */
@Injectable({ providedIn: 'root' })
export class CrossPlatformCmdService {
  createDirectory(path: string, _recursive = true): Promise<never> {
    return this.unsupported('创建目录', path);
  }

  copyItem(source: string, destination: string, _recursive = true, _force = true): Promise<never> {
    return this.unsupported('复制文件', `${source} -> ${destination}`);
  }

  linkItem(source: string, destination: string): Promise<never> {
    return this.unsupported('链接文件', `${source} -> ${destination}`);
  }

  deleteItem(path: string): Promise<never> {
    return this.unsupported('删除文件', path);
  }

  removeItem(path: string, _recursive = true, _force = true): Promise<never> {
    return this.unsupported('删除文件', path);
  }

  moveItem(source: string, destination: string, _force = true): Promise<never> {
    return this.unsupported('移动文件', `${source} -> ${destination}`);
  }

  testPath(path: string): Promise<never> {
    return this.unsupported('检查路径', path);
  }

  getChildItems(path: string, _recursive = false): Promise<never> {
    return this.unsupported('读取目录', path);
  }

  private unsupported(action: string, target: string): Promise<never> {
    return Promise.reject(new Error(`浏览器环境不支持${action}: ${target}`));
  }
}
