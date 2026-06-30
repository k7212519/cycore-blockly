import { Injectable } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom, map, Observable, throwError } from 'rxjs';
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

function apiUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}

@Injectable({ providedIn: 'root' })
export class EdaAuthService {
  private readonly authenticatedSubject = new BehaviorSubject(false);
  private readonly userSubject = new BehaviorSubject<EdaUser | null>(this.readStoredUser());
  private validatedToken: string | null = null;

  readonly authenticated$ = this.authenticatedSubject.asObservable();
  readonly user$ = this.userSubject.asObservable();

  constructor(private http: HttpClient) {}

  get token(): string | null {
    return sessionStorage.getItem(SESSION_TOKEN_KEY) || localStorage.getItem(SESSION_TOKEN_KEY);
  }

  get isAuthenticated(): boolean {
    return this.authenticatedSubject.value;
  }

  async initialize(): Promise<boolean> {
    return this.ensureAuthenticated();
  }

  async ensureAuthenticated(): Promise<boolean> {
    const token = this.token;
    if (!token) {
      this.clearLocalSession();
      return false;
    }

    if (this.authenticatedSubject.value && this.validatedToken === token) {
      return true;
    }

    try {
      const response = await firstValueFrom(this.validateToken());
      this.validatedToken = token;
      this.userSubject.next(response.data);
      this.authenticatedSubject.next(true);
      this.storeUser(response.data);
      return true;
    } catch {
      this.clearLocalSession();
      return false;
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
    return this.http
      .request<ApiResponse<T>>(method, apiUrl(path), {
        body,
        headers: this.token ? { Authorization: `Bearer ${this.token.trim()}` } : {},
      })
      .pipe(
        map((response) => {
          if (response.code !== 200) {
            throw new Error(response.message || '请求失败');
          }
          return response;
        }),
        catchError((error: unknown) => {
          if (error instanceof HttpErrorResponse && error.status === 401) {
            this.clearLocalSession();
          }

          const message =
            error instanceof Error
              ? error.message
              : '网络连接失败，请稍后重试';
          return throwError(() => new Error(message));
        })
      );
  }
}
