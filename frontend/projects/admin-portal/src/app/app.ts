import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Icon, Logo } from '@aerotrack/shared';
import { Activity, KeyRound, LayoutDashboard, LogOut, Users } from 'lucide';
import { AdminAuthService } from './core/admin-auth.service';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Logo, Icon],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly auth = inject(AdminAuthService);
  protected readonly icons = { KeyRound, LayoutDashboard, LogOut };
  /** The console chrome is shown once the admin is fully signed in (no pending password change). */
  protected readonly shell = computed(() => {
    const admin = this.auth.admin();
    return !!admin && !admin.mustChangePassword;
  });
  protected readonly navigation = [
    { path: '/', label: 'Overview', icon: LayoutDashboard, exact: true },
    { path: '/users', label: 'Users', icon: Users, exact: false },
    { path: '/performance', label: 'Performance', icon: Activity, exact: false },
  ];
}
