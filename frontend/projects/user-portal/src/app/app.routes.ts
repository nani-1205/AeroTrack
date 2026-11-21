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
    title: 'Airlines · AeroTrack',
    loadComponent: () => import('./pages/airlines/airlines').then((m) => m.AirlinesPage),
  },
  {
    path: 'airlines/:icao',
    canActivate: [authGuard],
    title: 'Active flights · AeroTrack',
    loadComponent: () => import('./pages/flights/flights').then((m) => m.FlightsPage),
  },
  {
    path: 'track',
    canActivate: [authGuard],
    title: 'Live tracking · AeroTrack',
    loadComponent: () => import('./pages/track/track').then((m) => m.TrackPage),
  },
  { path: '**', redirectTo: '' },
];
