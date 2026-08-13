import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { EdaAuthService } from './eda-auth.service';

describe('EdaAuthService session invalidation', () => {
  let auth: EdaAuthService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();

    TestBed.configureTestingModule({
      providers: [
        EdaAuthService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });

    auth = TestBed.inject(EdaAuthService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    auth.clearLocalSession();
    httpMock.verify();
  });

  it('keeps a new login when an anonymous request returns 401 late', async () => {
    const staleRequest = firstValueFrom(auth.checkUsername('student'));
    const pendingStaleRequest = httpMock.expectOne(
      request => request.url.includes('/eda/register/check-username/student')
    );
    expect(pendingStaleRequest.request.headers.has('Authorization')).toBeFalse();

    const login = firstValueFrom(auth.login({
      username: 'student',
      password: 'password',
      rememberMe: false,
    }));
    const loginRequest = httpMock.expectOne(request => request.url.endsWith('/eda/login'));
    loginRequest.flush({
      code: 200,
      message: '登录成功',
      data: {
        userId: 7,
        username: 'student',
        token: 'new-session-token',
        productCode: 'L2',
        productAccess: { status: 'ACTIVE' },
      },
    });
    await login;

    pendingStaleRequest.flush(
      { code: 401, message: '未提供有效的令牌', data: null },
      { status: 401, statusText: 'Unauthorized' }
    );
    await expectAsync(staleRequest).toBeRejected();

    expect(auth.token).toBe('new-session-token');
    expect(auth.isAuthenticated).toBeTrue();
    expect(auth.hasProductAccess).toBeTrue();
  });
});
