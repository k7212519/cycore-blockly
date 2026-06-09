import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzMessageService } from 'ng-zorro-antd/message';
import { Subject, takeUntil } from 'rxjs';
import { EdaAuthService } from '../../auth/eda-auth.service';
import { EdaUser } from '../../auth/auth.models';
import { ToolContainerComponent } from '../../components/tool-container/tool-container.component';
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
  loggingOut = false;

  constructor(
    private auth: EdaAuthService,
    private uiService: UiService,
    private router: Router,
    private message: NzMessageService
  ) {}

  ngOnInit(): void {
    this.auth.user$
      .pipe(takeUntil(this.destroy$))
      .subscribe((user) => (this.currentUser = user));
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

  private finishLogout(): void {
    this.auth.clearLocalSession();
    this.uiService.closeTool('user-center');
    this.message.success('已退出登录');
    this.loggingOut = false;
    void this.router.navigate(['/login']);
  }
}
