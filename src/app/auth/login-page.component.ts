import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { NzMessageService } from 'ng-zorro-antd/message';
import { finalize } from 'rxjs/operators';
import { EdaAuthService } from './eda-auth.service';

@Component({
  selector: 'app-login-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterLink],
  templateUrl: './login-page.component.html',
  styleUrl: './auth-page.scss',
})
export class LoginPageComponent {
  private readonly fb = inject(FormBuilder);
  submitting = false;

  readonly form = this.fb.nonNullable.group({
    username: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(50)]],
    password: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(50)]],
    rememberMe: [false],
  });

  constructor(
    private auth: EdaAuthService,
    private router: Router,
    private route: ActivatedRoute,
    private message: NzMessageService
  ) {
    const savedUsername = localStorage.getItem('eda_saved_username');
    if (savedUsername) {
      this.form.patchValue({ username: savedUsername, rememberMe: true });
    }
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    this.submitting = true;
    this.auth
      .login(value)
      .pipe(finalize(() => (this.submitting = false)))
      .subscribe({
        next: () => {
          if (value.rememberMe) {
            localStorage.setItem('eda_saved_username', value.username.trim());
          } else {
            localStorage.removeItem('eda_saved_username');
          }

          this.message.success('登录成功');
          const redirect = this.route.snapshot.queryParamMap.get('redirect');
          void this.router.navigateByUrl(this.safeRedirect(redirect));
        },
        error: (error: Error) => this.message.error(error.message || '登录失败'),
      });
  }

  private safeRedirect(redirect: string | null): string {
    return redirect?.startsWith('/') && !redirect.startsWith('//')
      ? redirect
      : '/main/guide';
  }
}
