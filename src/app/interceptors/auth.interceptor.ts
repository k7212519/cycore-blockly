import { inject } from '@angular/core';
import { HttpInterceptorFn, HttpRequest, HttpHandlerFn, HttpEvent, HttpErrorResponse, HttpResponse } from '@angular/common/http';
import { Observable, throwError, catchError, tap } from 'rxjs';
import { EdaAuthService } from '../auth/eda-auth.service';

export const authInterceptor: HttpInterceptorFn = (req: HttpRequest<any>, next: HttpHandlerFn): Observable<HttpEvent<any>> => {
  const authService = inject(EdaAuthService);
  const token = authService.token;
  const request = token && !req.headers.has('Authorization')
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token.trim()}` } })
    : req;
  const requestToken = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim() || null;

  return next(request).pipe(
    tap(event => {
      if (
        event instanceof HttpResponse
        && event.body
        && typeof event.body === 'object'
        && 'code' in event.body
        && event.body.code === 401
      ) {
        authService.invalidateSession(undefined, requestToken);
      }
    }),
    catchError(error => {
      if (error instanceof HttpErrorResponse && error.status === 401) {
        authService.invalidateSession(undefined, requestToken);
      }
      return throwError(() => error);
    })
  );
};
