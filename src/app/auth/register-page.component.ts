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
  selector: 'app-register-page',
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterLink],
  templateUrl: './register-page.component.html',
  styleUrl: './auth-page.scss',
})
export class RegisterPageComponent {
  private readonly fb = inject(FormBuilder);
  submitting = false;

  readonly form = this.fb.nonNullable.group(
    {
      username: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(50)]],
      password: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(50)]],
      confirmPassword: ['', Validators.required],
      activationCode: ['', [Validators.required, Validators.pattern(/^\d{16}$/)]],
    },
    { validators: matchingPasswords }
  );

  constructor(
    private auth: EdaAuthService,
    private router: Router,
    private message: NzMessageService
  ) {}

  checkUsername(): void {
    const control = this.form.controls.username;
    if (control.invalid) return;

    this.auth.checkUsername(control.value.trim()).subscribe({
      error: (error: Error) => {
        control.setErrors({ ...(control.errors || {}), unavailable: true });
        this.message.warning(error.message);
      },
    });
  }

  validateCode(): void {
    const control = this.form.controls.activationCode;
    if (control.invalid) return;

    this.auth.validateActivationCode(control.value.trim()).subscribe({
      error: (error: Error) => {
        control.setErrors({ ...(control.errors || {}), invalidCode: true });
        this.message.warning(error.message);
      },
    });
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }

    const value = this.form.getRawValue();
    this.submitting = true;
    this.auth
      .register({
        username: value.username.trim(),
        password: value.password,
        confirmPassword: value.confirmPassword,
        activationCode: value.activationCode.trim(),
      })
      .pipe(finalize(() => (this.submitting = false)))
      .subscribe({
        next: () => {
          this.message.success('注册成功，请登录');
          void this.router.navigate(['/login']);
        },
        error: (error: Error) => this.message.error(error.message || '注册失败'),
      });
  }
}
