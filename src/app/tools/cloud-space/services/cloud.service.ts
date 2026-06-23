import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { API } from '../../../configs/api.config';

@Injectable({ providedIn: 'root' })
export class CloudService {
  constructor(private http: HttpClient) {}

  getPublicProjects(page: number, perPage: number, keyword: string, id = '', board = ''): Observable<any> {
    const params = new URLSearchParams({
      page: String(page),
      perPage: String(perPage),
      keywords: keyword || '',
      id,
      board,
    });
    return this.http.get<any>(`${API.cloudPublicProjects}?${params.toString()}`);
  }

  resolveCloudFileUrl(url: string | null | undefined): string {
    if (!url) return '';
    if (/^https?:\/\//i.test(url)) return url;
    const cloudBase = API.cloudBase.replace(/\/$/, '');
    try {
      if (url.startsWith('/api/')) return `${new URL(cloudBase).origin}${url}`;
    } catch {}
    return `${cloudBase}/${url.replace(/^\/+/, '')}`;
  }

  getProjectArchiveBlob(archiveUrl: string): Observable<Blob> {
    return this.http.get(this.resolveCloudFileUrl(archiveUrl), { responseType: 'blob' });
  }
}
