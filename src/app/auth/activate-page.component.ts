import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { NzMessageService } from 'ng-zorro-antd/message';
import { finalize } from 'rxjs/operators';
import { EdaAuthService } from './eda-auth.service';

@Component({
  selector: 'app-activate-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './activate-page.component.html',
  styleUrl: './auth-page.scss',
})
export class ActivatePageComponent {
  private readonly fb = inject(FormBuilder);
  submitting = false;
  readonly form = this.fb.nonNullable.group({
    activationCode: ['', [Validators.required, Validators.minLength(4), Validators.maxLength(100)]],
  });

  constructor(
    readonly auth: EdaAuthService,
    private router: Router,
    private route: ActivatedRoute,
    private message: NzMessageService
  ) {}

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting = true;
    this.auth.activateProduct(this.form.getRawValue().activationCode.trim())
      .pipe(finalize(() => (this.submitting = false)))
      .subscribe({
        next: () => {
          this.message.success('L2 产品权限已激活');
          const redirect = this.route.snapshot.queryParamMap.get('redirect');
          void this.router.navigateByUrl(
            redirect?.startsWith('/') && !redirect.startsWith('//') ? redirect : '/main/guide'
          );
        },
        error: (error: Error) => this.message.error(error.message || '激活失败'),
      });
  }

  logout(): void {
    this.auth.logout().subscribe({
      next: () => void this.router.navigate(['/login']),
      error: () => void this.router.navigate(['/login']),
    });
  }
}
