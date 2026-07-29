import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzModalRef } from 'ng-zorro-antd/modal';
import { NzMessageService } from 'ng-zorro-antd/message';
import { BaseDialogComponent } from '../base-dialog/base-dialog.component';
import { ProjectService } from '../../services/project.service';

@Component({
  selector: 'app-project-import-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, BaseDialogComponent],
  templateUrl: './project-import-dialog.component.html',
  styleUrl: './project-import-dialog.component.scss'
})
export class ProjectImportDialogComponent {
  readonly modal = inject(NzModalRef);
  private readonly projectService = inject(ProjectService);
  private readonly message = inject(NzMessageService);

  shareCode = '';
  loading = false;

  get codeValid(): boolean {
    return /^[A-Z]{8}$/.test(this.shareCode);
  }

  onCodeInput(value: string): void {
    this.shareCode = (value || '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .slice(0, 8);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.codeValid && !this.loading) {
      event.preventDefault();
      void this.importProject();
    }
  }

  onClose(): void {
    if (!this.loading) {
      this.modal.close();
    }
  }

  async onButtonClick(action: string): Promise<void> {
    if (action === 'import') {
      await this.importProject();
    } else {
      this.onClose();
    }
  }

  private async importProject(): Promise<void> {
    if (!this.codeValid || this.loading) {
      return;
    }
    this.loading = true;
    try {
      const project = await this.projectService.importSharedProject(this.shareCode);
      this.message.success(`项目「${project.name}」已导入`);
      this.modal.close({ project });
    } catch (error: any) {
      this.message.error(error?.message || '分享码无效或项目已过期');
      this.loading = false;
    }
  }
}
