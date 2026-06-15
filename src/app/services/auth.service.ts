import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, firstValueFrom, map } from 'rxjs';
import { EdaAuthService } from '../auth/eda-auth.service';
import { EdaUser } from '../auth/auth.models';

export interface CommonResponse {
  status: number;
  message: string;
  data?: any;
}

/**
 * Compatibility facade for modules that have not yet migrated to EdaAuthService.
 * It intentionally contains no login, email-code, OAuth, SSO, or refresh-token flow.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly isLoggedIn$;
  readonly userInfo$;
  readonly showUser = new BehaviorSubject<boolean>(false);

  private user: EdaUser | null = null;

  constructor(
    private edaAuth: EdaAuthService,
    private router: Router
  ) {
    this.isLoggedIn$ = this.edaAuth.authenticated$;
    this.userInfo$ = this.edaAuth.user$.pipe(map((user) => this.toLegacyUser(user)));
    this.edaAuth.user$.subscribe((user) => (this.user = user));
  }

  get isLoggedIn(): boolean {
    return this.edaAuth.isAuthenticated;
  }

  get isAuthenticated(): boolean {
    return this.edaAuth.isAuthenticated;
  }

  get currentUser(): any {
    return this.toLegacyUser(this.user);
  }

  async initializeAuth(): Promise<void> {
    await this.edaAuth.initialize();
  }

  async getToken2(): Promise<string | null> {
    return this.edaAuth.token;
  }

  get token(): string {
    return this.edaAuth.token || '';
  }

  get userInfo(): any {
    return this.currentUser;
  }

  getAuthHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.edaAuth.logout());
    } catch {
      this.edaAuth.clearLocalSession();
    }
  }

  refreshMe(): void {
    void this.edaAuth.ensureAuthenticated();
  }

  async promptLogin(): Promise<boolean> {
    await this.router.navigate(['/login']);
    return false;
  }

  hasFeaturePreviewAccess(): boolean {
    return false;
  }

  private toLegacyUser(user: EdaUser | null): any {
    if (!user) return null;
    return {
      id: String(user.userId),
      userId: user.userId,
      nickname: user.realName || user.username,
      username: user.username,
      groups: [],
    };
  }
}
