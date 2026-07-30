import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { EdaAuthService } from './eda-auth.service';

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(EdaAuthService);
  const router = inject(Router);

  if (await auth.ensureAuthenticated()) {
    return auth.hasProductAccess
      ? true
      : router.createUrlTree(['/activate'], {
          queryParams: { redirect: state.url },
        });
  }

  return router.createUrlTree(['/login'], {
    queryParams: { redirect: state.url },
  });
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(EdaAuthService);
  const router = inject(Router);

  if (await auth.ensureAuthenticated()) {
    return router.createUrlTree([auth.hasProductAccess ? '/main/guide' : '/activate']);
  }

  return true;
};

export const activationGuard: CanActivateFn = async () => {
  const auth = inject(EdaAuthService);
  const router = inject(Router);

  if (!(await auth.ensureAuthenticated())) {
    return router.createUrlTree(['/login']);
  }
  return auth.hasProductAccess
    ? router.createUrlTree(['/main/guide'])
    : true;
};
