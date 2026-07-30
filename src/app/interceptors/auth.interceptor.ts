import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpEvent, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { Observable, throwError, catchError, tap } from 'rxjs';
import { EdaAuthService } from '../auth/eda-auth.service';
import { Router } from '@angular/router';

export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<any>, next: HttpHandlerFn): Observable<HttpEvent<any>> => {
  const authService = inject(EdaAuthService);
  const router = inject(Router);
  const token = authService.token;
  const request = token && !req.headers.has('Authorization')
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token.trim()}` } })
    : req;
  const requestToken = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() || null;

  return next(request).pipe(
    tap(event => {
      const responseBody = event instanceof HttpResponse
        ? event.body as { code?: number; errorCode?: string } | null
        : null;
      if (
        event instanceof HttpResponse
        && responseBody?.code === 401
      ) {
        authService.invalidateSession(undefined, requestToken);
      }
      if (
        event instanceof HttpResponse
        && responseBody?.code === 403
        && (responseBody.errorCode === 'PRODUCT_ACCESS_REQUIRED'
          || responseBody.errorCode === 'PRODUCT_ACCESS_REVOKED')
      ) {
        authService.markProductAccessUnavailable(responseBody.errorCode === 'PRODUCT_ACCESS_REVOKED');
        void router.navigate(['/activate'], { queryParams: { redirect: router.url } });
      }
    }),
    catchError(error => {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        authService.invalidateSession(undefined, requestToken);
      }
      if (
        error instanceof HttpErrorResponse
        && error.status === 403
        && (error.error?.errorCode === 'PRODUCT_ACCESS_REQUIRED'
          || error.error?.errorCode === 'PRODUCT_ACCESS_REVOKED')
      ) {
        authService.markProductAccessUnavailable(error.error.errorCode === 'PRODUCT_ACCESS_REVOKED');
        void router.navigate(['/activate'], { queryParams: { redirect: router.url } });
      }
      return throwError(() => error);
    })
  );
};
