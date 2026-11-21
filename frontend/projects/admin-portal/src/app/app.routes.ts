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
    title: 'Overview · AeroTrack Admin',
    loadComponent: () => import('./pages/dashboard/dashboard').then((m) => m.DashboardPage),
  },
  {
    path: 'users',
    canActivate: [adminGuard],
    title: 'Users · AeroTrack Admin',
    loadComponent: () => import('./pages/users/users').then((m) => m.UsersPage),
  },
  {
    path: 'performance',
    canActivate: [adminGuard],
    title: 'System performance · AeroTrack Admin',
    loadComponent: () => import('./pages/performance/performance').then((m) => m.PerformancePage),
  },
  { path: '**', redirectTo: '' },
];
