import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { EdaAuthService } from './eda-auth.service';

export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(EdaAuthService);
  const router = inject(Router);

  if (await auth.ensureAuthenticated()) {
    return true;
  }

  return router.createUrlTree(['/login'], {
    queryParams: { redirect: state.url },
  });
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(EdaAuthService);
  const router = inject(Router);

  if (await auth.ensureAuthenticated()) {
    return router.createUrlTree(['/main/guide']);
  }

  return true;
};
