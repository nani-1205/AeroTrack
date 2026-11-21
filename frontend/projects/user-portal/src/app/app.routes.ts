import { Routes } from '@angular/router';
import { authGuard, guestGuard } from './core/auth.guards';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in · AeroTrack',
    loadComponent: () => import('./pages/login/login').then((m) => m.LoginPage),
  },
  {
    path: '',
    pathMatch: 'full',
    canActivate: [authGuard],
    title: 'AeroTrack',
    loadComponent: () => import('./pages/home/home').then((m) => m.HomePage),
  },
  { path: '**', redirectTo: '' },
];
