import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subject, takeUntil } from 'rxjs';
import { EdaAuthService } from '../../auth/eda-auth.service';
import { EdaUser } from '../../auth/auth.models';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
import { ProjectService, ServerProjectCapacity } from '../../services/project.service';
import { UiService } from '../../services/ui.service';

@Component({
  selector: 'app-user-center',
  standalone: true,
  imports: [CommonModule, ToolContainerComponent, NzButtonModule],
  templateUrl: './user-center.component.html',
  styleUrl: './user-center.component.scss',
})
export class UserCenterComponent implements OnInit, OnDestroy {
  private readonly destroy$ = new Subject<void>();

  currentUser: EdaUser | null = null;
  capacity: ServerProjectCapacity | null = null;
  capacityLoading = false;
  capacityError = '';
  loggingOut = false;

  constructor(
    private auth: EdaAuthService,
    private projectService: ProjectService,
    private uiService: UiService,
    private router: Router,
    private message: NzMessageService
  ) {}

  ngOnInit(): void {
    this.auth.user$
      .pipe(takeUntil(this.destroy$))
      .subscribe((user) => (this.currentUser = user));
    void this.loadCapacity();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  close(): void {
    this.uiService.closeTool('user-center');
  }

  logout(): void {
    if (this.loggingOut) return;

    this.loggingOut = true;
    this.auth.logout().subscribe({
      next: () => this.finishLogout(),
      error: () => this.finishLogout(),
    });
  }

  get accountTypeLabel(): string {
    if (this.capacity?.accountTypeLabel) {
      return this.capacity.accountTypeLabel;
    }
    if (this.currentUser?.userType === '01') {
      return '学生VIP';
    }
    if (this.currentUser?.userType === '02') {
      return '教师';
    }
    return this.currentUser?.userType || '普通用户';
  }

  get isStudentVip(): boolean {
    return (this.capacity?.userType || this.currentUser?.userType) === '01';
  }

  get isTeacher(): boolean {
    return (this.capacity?.userType || this.currentUser?.userType) === '02';
  }

  get capacityPercent(): number {
    if (!this.capacity?.limit) {
      return 0;
    }
    return Math.min(100, Math.round((this.capacity.used / this.capacity.limit) * 100));
  }

  get capacityText(): string {
    if (this.capacityLoading) {
      return '加载中';
    }
    if (!this.capacity) {
      return '-';
    }
    return `${this.capacity.used} / ${this.capacity.limit}`;
  }

  get capacityDetailText(): string {
    return this.capacity ? `${this.capacityText} 个` : this.capacityText;
  }

  private async loadCapacity(): Promise<void> {
    this.capacityLoading = true;
    this.capacityError = '';
    try {
      this.capacity = await this.projectService.getServerProjectCapacity();
    } catch (error) {
      this.capacityError = error instanceof Error ? error.message : '容量信息加载失败';
    } finally {
      this.capacityLoading = false;
    }
  }

  private finishLogout(): void {
    this.auth.clearLocalSession();
    this.uiService.closeTool('user-center');
    this.message.success('已退出登录');
    this.loggingOut = false;
    void this.router.navigate(['/login']);
  }
}
