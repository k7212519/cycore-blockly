import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API } from '../configs/api.config';
import { ProjectService } from './project.service';

@Injectable({ providedIn: 'root' })
export class NpmService {
  isInstalling = false;

  constructor(
    private http: HttpClient,
    private projectService: ProjectService,
  ) {}

  async init(): Promise<void> {}

  list(data: any) {
    return this.http.get<ResponseModel>(API.projectList, { params: data });
  }

  search(data: any) {
    return this.http.get<SearchResponseModel>(API.projectSearch, { params: data });
  }

  async getPackageVersionList(packageName: string): Promise<string[]> {
    const packageUrl = `${API.registryBase}/${encodeURIComponent(packageName)}`;
    const packageInfo: any = await firstValueFrom(this.http.get(packageUrl));
    return Object.keys(packageInfo?.versions || {});
  }

  async getAllInstalledLibraries(_path?: string): Promise<any[]> {
    return this.projectService.getServerProjectLibraries();
  }
}

export interface SearchResponseModel {
  objects: any[];
  time: string;
  total: number;
}

export interface ResponseModel {
  status: number;
  messages: string;
  data: any;
}
