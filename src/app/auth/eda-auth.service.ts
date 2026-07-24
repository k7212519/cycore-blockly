import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom, map, Observable, ReplaySubject, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { getApiBaseUrl } from '../configs/api.config';
import {
  ApiResponse,
  EdaUser,
  LoginRequest,
  LoginResponse,
  RecoverRequest,
  RecoveryCodeResult,
  RegisterRequest,
} from './auth.models';

const SESSION_TOKEN_KEY = 'eda_token';
const USER_KEY = 'eda_user';
const USER_ID_KEY = 'userId';
const SESSION_REVALIDATE_INTERVAL_MS = 10_000;
const SESSION_INVALID_MESSAGE = '当前登录已失效，账号可能已在其他设备登录，请重新登录';

function apiUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}

@Injectable({ providedIn: 'root' })
export class EdaAuthService {
  private readonly authenticatedSubject = new BehaviorSubject(false);
  private readonly userSubject = new BehaviorSubject<EdaUser | null>(this.readStoredUser());
  private readonly sessionInvalidatedSubject = new ReplaySubject<string>(1);
  private validatedToken: string | null = null;
  private validationInFlight: Promise<boolean> | null = null;
  private validationToken: string | null = null;
  private sessionMonitorId?: number;

  readonly authenticated$ = this.authenticatedSubject.asObservable();
  readonly user$ = this.userSubject.asObservable();
  readonly sessionInvalidated$ = this.sessionInvalidatedSubject.asObservable();

  private readonly revalidateActiveSession = (): void => {
    if (!this.token || document.visibilityState === 'hidden') return;
    void this.ensureAuthenticated(true);
  };

  private readonly handleTokenStorageChange = (event: StorageEvent): void => {
    if (event.key !== SESSION_TOKEN_KEY) return;

    const sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (event.newValue && sessionToken && event.newValue.trim() !== sessionToken.trim()) {
      // 同一浏览器的其他标签页完成新登录时，采用新 token，避免旧标签页
      // 清除刚生成的共享 localStorage 会话。
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      sessionStorage.removeItem(USER_ID_KEY);
      this.validatedToken = null;
    }
    this.revalidateActiveSession();
  };

  constructor(private http: HttpClient) {}

  get token(): string | null {
    return sessionStorage.getItem(SESSION_TOKEN_KEY) || localStorage.getItem(SESSION_TOKEN_KEY);
  }

  get isAuthenticated(): boolean {
    return this.authenticatedSubject.value;
  }

  async initialize(): Promise<boolean> {
    const authenticated = await this.ensureAuthenticated(true);
    if (authenticated) {
      this.startSessionMonitor();
    }
    return authenticated;
  }

  async ensureAuthenticated(forceValidation = false): Promise<boolean> {
    const token = this.token;
    if (!token) {
      this.clearLocalSession();
      return false;
    }

    if (!forceValidation && this.authenticatedSubject.value && this.validatedToken === token) {
      return true;
    }

    if (!this.validationInFlight || this.validationToken !== token) {
      this.validationInFlight = this.performTokenValidation(token);
      this.validationToken = token;
    }

    const validation = this.validationInFlight;
    try {
      return await validation;
    } finally {
      if (this.validationInFlight === validation) {
        this.validationInFlight = null;
        this.validationToken = null;
      }
    }
  }

  login(request: LoginRequest): Observable<ApiResponse<LoginResponse>> {
    return this.request<LoginResponse>('POST', '/eda/login', request).pipe(
      map((response) => {
        this.saveSession(response.data, request.rememberMe);
        return response;
      })
    );
  }

  logout(): Observable<ApiResponse<void>> {
    return this.request<void>('DELETE', '/eda/login').pipe(
      catchError(() => {
        this.clearLocalSession();
        return throwError(() => new Error('退出请求失败'));
      }),
      map((response) => {
        this.clearLocalSession();
        return response;
      })
    );
  }

  validateToken(): Observable<ApiResponse<LoginResponse>> {
    return this.request<LoginResponse>('GET', '/eda/login/validate');
  }

  invalidateSession(message = SESSION_INVALID_MESSAGE, invalidToken?: string | null): void {
    if (invalidToken && this.token?.trim() !== invalidToken.trim()) {
      return;
    }

    const hadSession = Boolean(this.token) || this.authenticatedSubject.value || Boolean(this.userSubject.value);
    this.clearLocalSession();
    if (hadSession) {
      this.sessionInvalidatedSubject.next(message);
    }
  }

  register(request: RegisterRequest): Observable<ApiResponse<string>> {
    return this.request<string>('POST', '/eda/register', request);
  }

  validateActivationCode(code: string): Observable<ApiResponse<boolean>> {
    return this.request<boolean>('GET', `/eda/register/validate-code/${encodeURIComponent(code)}`);
  }

  checkUsername(username: string): Observable<ApiResponse<boolean>> {
    return this.request<boolean>('GET', `/eda/register/check-username/${encodeURIComponent(username)}`);
  }

  validateRecoveryCode(code: string): Observable<ApiResponse<RecoveryCodeResult>> {
    return this.request<RecoveryCodeResult>('GET', `/eda/recover/validate-code/${encodeURIComponent(code)}`);
  }

  resetAccount(request: RecoverRequest): Observable<ApiResponse<string>> {
    return this.request<string>('POST', '/eda/recover/reset', request);
  }

  clearLocalSession(): void {
    this.stopSessionMonitor();
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(USER_ID_KEY);
    localStorage.removeItem(USER_ID_KEY);
    localStorage.removeItem(USER_KEY);
    this.validatedToken = null;
    this.userSubject.next(null);
    this.authenticatedSubject.next(false);
  }

  private saveSession(response: LoginResponse, rememberMe: boolean): void {
    const target = rememberMe ? localStorage : sessionStorage;
    const other = rememberMe ? sessionStorage : localStorage;

    target.setItem(SESSION_TOKEN_KEY, response.token.trim());
    target.setItem(USER_ID_KEY, String(response.userId));
    other.removeItem(SESSION_TOKEN_KEY);
    other.removeItem(USER_ID_KEY);

    this.validatedToken = response.token.trim();
    this.storeUser(response);
    this.userSubject.next(response);
    this.authenticatedSubject.next(true);
    this.startSessionMonitor();
  }

  private storeUser(user: EdaUser): void {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  private readStoredUser(): EdaUser | null {
    const value = localStorage.getItem(USER_KEY);
    if (!value) return null;

    try {
      return JSON.parse(value) as EdaUser;
    } catch {
      localStorage.removeItem(USER_KEY);
      return null;
    }
  }

  private request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown
  ): Observable<ApiResponse<T>> {
    const requestToken = this.token?.trim() || null;
    return this.http
      .request<ApiResponse<T>>(method, apiUrl(path), {
        body,
        headers: requestToken ? { Authorization: `Bearer ${requestToken}` } : {},
      })
      .pipe(
        map((response) => {
          if (response.code !== 200) {
            if (response.code === 401) {
              this.invalidateSession(SESSION_INVALID_MESSAGE, requestToken);
            }
            throw new Error(response.message || '请求失败');
          }
          return response;
        }),
        catchError((error: unknown) => {
          if (error instanceof HttpErrorResponse && error.status === 401) {
            this.invalidateSession(SESSION_INVALID_MESSAGE, requestToken);
          }

          const message =
            error instanceof Error
              ? error.message
              : '网络连接失败，请稍后重试';
          return throwError(() => new Error(message));
        })
      );
  }

  private async performTokenValidation(token: string): Promise<boolean> {
    try {
      const response = await firstValueFrom(this.validateToken());
      if (this.token !== token) {
        return this.authenticatedSubject.value;
      }

      this.validatedToken = token;
      this.userSubject.next(response.data);
      this.authenticatedSubject.next(true);
      this.storeUser(response.data);
      return true;
    } catch {
      if (!this.token) {
        return false;
      }

      // 周期校验遇到临时网络错误时保留现有会话，避免误退出。
      if (this.authenticatedSubject.value) {
        return true;
      }

      this.clearLocalSession();
      return false;
    }
  }

  private startSessionMonitor(): void {
    this.stopSessionMonitor();
    if (!this.token) return;

    this.sessionMonitorId = window.setInterval(
      this.revalidateActiveSession,
      SESSION_REVALIDATE_INTERVAL_MS
    );
    window.addEventListener('focus', this.revalidateActiveSession);
    window.addEventListener('storage', this.handleTokenStorageChange);
    document.addEventListener('visibilitychange', this.revalidateActiveSession);
  }

  private stopSessionMonitor(): void {
    if (this.sessionMonitorId !== undefined) {
      window.clearInterval(this.sessionMonitorId);
      this.sessionMonitorId = undefined;
    }
    window.removeEventListener('focus', this.revalidateActiveSession);
    window.removeEventListener('storage', this.handleTokenStorageChange);
    document.removeEventListener('visibilitychange', this.revalidateActiveSession);
  }
}
