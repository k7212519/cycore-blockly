import { CommonModule } from '@angular/common';
import { Component, inject } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { NzMessageService } from 'ng-zorro-antd/message';
import { finalize } from 'rxjs/operators';
import { EdaAuthService } from './eda-auth.service';

function matchingPasswords(control: AbstractControl): ValidationErrors | null {
  return control.get('password')?.value === control.get('confirmPassword')?.value
    ? null
    : { passwordMismatch: true };
}

@Component({
  selector: 'app-recover-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterLink],
  templateUrl: './recover-page.component.html',
  styleUrl: './auth-page.scss',
})
export class RecoverPageComponent {
  private readonly fb = inject(FormBuilder);
  step: 1 | 2 = 1;
  verifying = false;
  resetting = false;
  verifiedCode = '';

  readonly codeForm = this.fb.nonNullable.group({
    activationCode: ['', [Validators.required, Validators.pattern(/^\d{16}$/)]],
  });

  readonly accountForm = this.fb.nonNullable.group(
    {
      username: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(50)]],
      password: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(50)]],
      confirmPassword: ['', Validators.required],
    },
    { validators: matchingPasswords }
  );

  constructor(
    private auth: EdaAuthService,
    private router: Router,
    private message: NzMessageService
  ) {}

  verifyCode(): void {
    if (this.codeForm.invalid) {
      this.codeForm.markAllAsTouched();
      return;
    }

    const code = this.codeForm.controls.activationCode.value.trim();
    this.verifying = true;
    this.auth
      .validateRecoveryCode(code)
      .pipe(finalize(() => (this.verifying = false)))
      .subscribe({
        next: (response) => {
          this.verifiedCode = code;
          this.step = 2;
          const masked = response.data.maskedUsername;
          this.message.success(masked ? `验证成功，关联账号：${masked}` : '验证成功');
        },
        error: (error: Error) => this.message.error(error.message || '激活码验证失败'),
      });
  }

  resetAccount(): void {
    if (this.accountForm.invalid || !this.verifiedCode) {
      this.accountForm.markAllAsTouched();
      return;
    }

    const value = this.accountForm.getRawValue();
    this.resetting = true;
    this.auth
      .resetAccount({
        username: value.username.trim(),
        password: value.password,
        confirmPassword: value.confirmPassword,
        activationCode: this.verifiedCode,
      })
      .pipe(finalize(() => (this.resetting = false)))
      .subscribe({
        next: () => {
          this.auth.clearLocalSession();
          this.message.success('账号重置成功，请使用新密码登录');
          void this.router.navigate(['/login']);
        },
        error: (error: Error) => this.message.error(error.message || '账号重置失败'),
      });
  }

  back(): void {
    this.step = 1;
    this.verifiedCode = '';
  }
}
