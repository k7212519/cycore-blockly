import { Injectable } from '@angular/core';
import { ElectronService } from './electron.service';
import { ProjectService, ServerFileNode } from './project.service';

@Injectable({
  providedIn: 'root',
})
export class ProjectResourceService {
  constructor(
    private projectService: ProjectService,
    private electronService: ElectronService,
  ) {}

  get isServerProject(): boolean {
    return this.projectService.isServerProject;
  }

  async getPackageJson(): Promise<any> {
    return this.projectService.getPackageJson();
  }

  async getBoardModule(): Promise<string> {
    return this.projectService.getBoardModule();
  }

  async getBoardPackageJson(): Promise<any | null> {
    try {
      return await this.projectService.getBoardPackageJson();
    } catch {
      return null;
    }
  }

  async getBoardPackagePath(): Promise<string> {
    const boardModule = await this.getBoardModule();
    if (!boardModule) {
      throw new Error('未找到开发板模块');
    }
    if (this.isServerProject) {
      return `node_modules/${boardModule}`;
    }
    return this.projectService.getBoardPackagePath();
  }

  async projectFileExists(relativePath: string): Promise<boolean> {
    if (this.isServerProject) {
      return this.serverProjectFileExists(relativePath);
    }

    return this.electronService.exists(this.joinLocal(this.projectService.currentProjectPath, relativePath));
  }

  async readProjectText(relativePath: string): Promise<string | null> {
    try {
      if (this.isServerProject) {
        if (!await this.projectFileExists(relativePath)) {
          return null;
        }
        return await this.projectService.readServerFile(relativePath);
      }
      const filePath = this.joinLocal(this.projectService.currentProjectPath, relativePath);
      if (!this.electronService.exists(filePath)) {
        return null;
      }
      return this.electronService.readFile(filePath);
    } catch {
      return null;
    }
  }

  async readProjectJson<T = any>(relativePath: string): Promise<T | null> {
    const text = await this.readProjectText(relativePath);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async writeProjectJson(relativePath: string, data: unknown): Promise<boolean> {
    try {
      const content = JSON.stringify(data, null, 2);
      if (this.isServerProject) {
        await this.projectService.saveServerFile(relativePath, content);
      } else {
        this.electronService.writeFile(
          this.joinLocal(this.projectService.currentProjectPath, relativePath),
          content,
        );
      }
      return true;
    } catch (e) {
      console.error('写入项目 JSON 失败:', relativePath, e);
      return false;
    }
  }

  async boardFileExists(relativePath: string): Promise<boolean> {
    const boardPath = await this.getBoardPackagePath();
    return this.resourceExists(this.joinResource(boardPath, relativePath));
  }

  async readBoardText(relativePath: string): Promise<string | null> {
    const boardPath = await this.getBoardPackagePath();
    return this.readResourceText(this.joinResource(boardPath, relativePath));
  }

  async readBoardJson<T = any>(relativePath: string): Promise<T | null> {
    const text = await this.readBoardText(relativePath);
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async resourceExists(path: string): Promise<boolean> {
    if (this.isServerProject) {
      return this.serverProjectFileExists(path);
    }
    return this.electronService.exists(path);
  }

  async readResourceText(path: string): Promise<string | null> {
    try {
      if (this.isServerProject) {
        if (!await this.resourceExists(path)) {
          return null;
        }
        return await this.projectService.readServerFile(path);
      }
      if (!this.electronService.exists(path)) {
        return null;
      }
      return this.electronService.readFile(path);
    } catch {
      return null;
    }
  }

  joinResource(...parts: string[]): string {
    if (this.isServerProject) {
      return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
    }
    return this.joinLocal(...parts);
  }

  private joinLocal(...parts: string[]): string {
    if (this.electronService.isElectron && window['path']?.join) {
      return window['path'].join(...parts);
    }
    return parts.filter(Boolean).join('/').replace(/\/+/g, '/');
  }

  private async serverProjectFileExists(relativePath: string): Promise<boolean> {
    const target = this.normalizeServerPath(relativePath);
    try {
      const tree = await this.projectService.getServerFileTree();
      return this.serverTreeContains(tree, target);
    } catch {
      return false;
    }
  }

  private serverTreeContains(nodes: ServerFileNode[] = [], target: string): boolean {
    for (const node of nodes) {
      if (this.normalizeServerPath(node.path) === target) {
        return true;
      }
      if (node.children?.length && this.serverTreeContains(node.children, target)) {
        return true;
      }
    }
    return false;
  }

  private normalizeServerPath(path: string): string {
    return (path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  }
}
