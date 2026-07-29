import { CommonModule } from '@angular/common';
import { Component, inject, OnInit } from '@angular/core';
import { NZ_MODAL_DATA, NzModalRef } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BaseDialogComponent } from '../base-dialog/base-dialog.component';
import { ProjectService, ServerProjectShare } from '../../services/project.service';

@Component({
  selector: 'app-project-share-dialog',
  standalone: true,
  imports: [CommonModule, BaseDialogComponent],
  templateUrl: './project-share-dialog.component.html',
  styleUrl: './project-share-dialog.component.scss'
})
export class ProjectShareDialogComponent implements OnInit {
  readonly modal = inject(NzModalRef);
  readonly data: { projectId: string; projectName: string } = inject(NZ_MODAL_DATA);
  private readonly projectService = inject(ProjectService);
  private readonly message = inject(NzMessageService);

  readonly expiryOptions = [
    { days: 1, label: '1 天', note: '临时协作' },
    { days: 7, label: '7 天', note: '推荐' },
    { days: 30, label: '30 天', note: '长期分享' },
    { days: 90, label: '90 天', note: '课程项目' }
  ];

  expiresInDays = 7;
  share: ServerProjectShare | null = null;
  loading = true;

  async ngOnInit(): Promise<void> {
    try {
      this.share = await this.projectService.getServerProjectShare(this.data.projectId);
    } catch (error: any) {
      this.message.error(error?.message || '分享信息加载失败');
    } finally {
      this.loading = false;
    }
  }

  selectExpiry(days: number): void {
    if (this.loading) {
      return;
    }
    this.expiresInDays = days;
    this.share = null;
  }

  onClose(): void {
    if (!this.loading) {
      this.modal.close(this.share ? { shared: true } : null);
    }
  }

  async onButtonClick(action: string): Promise<void> {
    if (action === 'share') {
      await this.createShare();
      return;
    }
    this.onClose();
  }

  private async createShare(): Promise<void> {
    this.loading = true;
    try {
      this.share = await this.projectService.shareServerProject(this.data.projectId, this.expiresInDays);
    } catch (error: any) {
      this.message.error(error?.message || '分享码生成失败');
    } finally {
      this.loading = false;
    }
  }

  async copyShareCode(): Promise<void> {
    if (!this.share?.shareCode) {
      return;
    }
    try {
      await navigator.clipboard.writeText(this.share.shareCode);
      this.message.success('分享码已复制');
    } catch {
      const input = document.createElement('textarea');
      input.value = this.share.shareCode;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      this.message.success('分享码已复制');
    }
  }
}
