import { Routes } from '@angular/router';
import { adminGuard, guestGuard, signedInGuard } from './core/admin.guards';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in · AeroTrack Admin',
    loadComponent: () => import('./pages/login/login').then((m) => m.AdminLoginPage),
  },
  {
    path: 'change-password',
    canActivate: [signedInGuard],
    title: 'Change password · AeroTrack Admin',
    loadComponent: () => import('./pages/change-password/change-password').then((m) => m.ChangePasswordPage),
  },
  {
    path: '',
    pathMatch: 'full',
    canActivate: [adminGuard],
    title: 'AeroTrack Admin',
    loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.DashboardPage),
  },
  { path: '**', redirectTo: '' },
];
