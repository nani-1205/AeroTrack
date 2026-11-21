import { Component, ElementRef, HostListener, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { Icon, Logo } from '@aerotrack/shared';
import { Building, ChevronDown, LogOut, Mail } from 'lucide';
import { AuthService } from './core/auth.service';

@Component({
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Logo, Icon],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly menuOpen = signal(false);
  protected readonly icons = { Building, ChevronDown, LogOut, Mail };

  @HostListener('document:click', ['$event'])
  protected closeMenu(event: MouseEvent): void {
    const menu = this.host.querySelector('.account');
    if (this.menuOpen() && menu && !menu.contains(event.target as Node)) this.menuOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  protected escape(): void {
    this.menuOpen.set(false);
  }

  protected async signOut(): Promise<void> {
    this.menuOpen.set(false);
    await this.auth.signOut();
  }
}
