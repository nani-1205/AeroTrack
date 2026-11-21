import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import type { Airline, Flight } from './models';

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'error';

export interface LiveHandlers {
  subscribed(airline: Omit<Airline, 'activeFlights'>, flights: Flight[]): void;
  positions(flights: Flight[], removed: string[], ts: number): void;
  ended(): void;
}

/** Same-origin `/ws` (the dev server proxies it to the gateway). */
export const LIVE_SOCKET_URL = new InjectionToken<() => string>('LIVE_SOCKET_URL', {
  factory: () => () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
});
export const WEB_SOCKET_FACTORY = new InjectionToken<(url: string) => WebSocket>('WEB_SOCKET_FACTORY', {
  factory: () => (url: string) => new WebSocket(url),
});
/** Reconnect delay for the n-th consecutive failure (1 s, 2 s, 4 s … max 30 s). */
export const RECONNECT_DELAY = new InjectionToken<(attempt: number) => number>('RECONNECT_DELAY', {
  factory: () => (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1)),
});

const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;

/**
 * One live-tracking subscription over the gateway WebSocket. Provide it per page
 * (`providers: [LiveSocket]`) so it closes when the page is destroyed.
 */
@Injectable()
export class LiveSocket {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly url = inject(LIVE_SOCKET_URL);
  private readonly create = inject(WEB_SOCKET_FACTORY);
  private readonly delay = inject(RECONNECT_DELAY);

  readonly status = signal<LiveStatus>('idle');
  readonly error = signal<string | null>(null);

  private ws: WebSocket | null = null;
  private ids: string[] = [];
  private handlers: LiveHandlers | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  track(ids: string[], handlers: LiveHandlers): void {
    this.ids = ids;
    this.handlers = handlers;
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close(1000, 'done');
    this.ws = null;
  }

  private open(): void {
    this.status.set(this.attempts > 0 ? 'reconnecting' : 'connecting');
    const ws = this.create(this.url());
    ws.onmessage = (e: MessageEvent<string>) => this.onFrame(e.data);
    ws.onclose = (e: CloseEvent) => {
      if (this.ws === ws) void this.onClose(e.code);
    };
    this.ws = ws;
  }

  private onFrame(raw: string): void {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.ws?.send(JSON.stringify({ type: 'subscribe', icao24: this.ids }));
        break;
      case 'subscribed':
        this.attempts = 0;
        this.error.set(null);
        this.status.set('live');
        this.handlers?.subscribed(msg['airline'] as Omit<Airline, 'activeFlights'>, msg['flights'] as Flight[]);
        break;
      case 'positions':
        this.handlers?.positions(msg['flights'] as Flight[], msg['removed'] as string[], msg['ts'] as number);
        break;
      case 'ended':
        this.finish('ended');
        this.handlers?.ended();
        break;
      case 'error':
        this.error.set(String(msg['message'] ?? 'Live tracking failed.'));
        this.finish('error');
        break;
    }
  }

  private finish(status: 'ended' | 'error'): void {
    this.status.set(status);
    this.stopped = true;
    this.ws?.close(1000, status);
  }

  private async onClose(code: number): Promise<void> {
    this.ws = null;
    if (this.stopped) return;
    if (code === CLOSE_FORBIDDEN) {
      this.error.set('This page is not allowed to open a live connection.');
      this.status.set('error');
      return;
    }
    this.attempts++;
    if (code === CLOSE_UNAUTHORIZED) {
      // Access token expired: renew the session, then reconnect straight away.
      try {
        await firstValueFrom(this.http.post('/api/auth/refresh', null));
      } catch {
        this.status.set('error');
        this.error.set('Your session expired. Please sign in again.');
        this.auth.sessionExpired();
        return;
      }
      if (!this.stopped) this.open();
      return;
    }
    this.status.set('reconnecting');
    this.retryTimer = setTimeout(() => {
      if (!this.stopped) this.open();
    }, this.delay(this.attempts));
  }
}
