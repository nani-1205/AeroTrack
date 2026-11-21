import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { LIVE_SOCKET_URL, LiveSocket, RECONNECT_DELAY, WEB_SOCKET_FACTORY } from './live-socket';
import type { Flight } from './models';

class FakeSocket {
  sent: unknown[] = [];
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  // test helpers
  emit(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop(code: number) { this.onclose?.({ code }); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const flight = (icao24: string) => ({ icao24, callsign: 'AIC1', airlineIcao: 'AIC' }) as Flight;

describe('LiveSocket', () => {
  let sockets: FakeSocket[];
  let live: LiveSocket;
  let events: string[];

  beforeEach(() => {
    sockets = [];
    events = [];
    TestBed.configureTestingModule({
      providers: [
        LiveSocket,
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: LIVE_SOCKET_URL, useValue: () => 'ws://test/ws' },
        { provide: WEB_SOCKET_FACTORY, useValue: () => { const s = new FakeSocket(); sockets.push(s); return s; } },
        { provide: RECONNECT_DELAY, useValue: () => 0 },
      ],
    });
    live = TestBed.inject(LiveSocket);
    live.track(['aaaaa1', 'aaaaa2'], {
      subscribed: (a, f) => events.push(`subscribed ${a.icao} ${f.length}`),
      positions: (f, r) => events.push(`positions ${f.map((x) => x.icao24).join()} -${r.join()}`),
      ended: () => events.push('ended'),
    });
  });

  it('subscribes once the gateway is ready and reports live updates', () => {
    expect(live.status()).toBe('connecting');
    sockets[0]!.emit({ type: 'ready' });
    expect(sockets[0]!.sent).toEqual([{ type: 'subscribe', icao24: ['aaaaa1', 'aaaaa2'] }]);

    sockets[0]!.emit({ type: 'subscribed', airline: { icao: 'AIC' }, flights: [flight('aaaaa1'), flight('aaaaa2')] });
    expect(live.status()).toBe('live');
    sockets[0]!.emit({ type: 'positions', ts: 1, flights: [flight('aaaaa1')], removed: ['aaaaa2'] });
    sockets[0]!.emit({ type: 'ended' });

    expect(events).toEqual(['subscribed AIC 2', 'positions aaaaa1 -aaaaa2', 'ended']);
    expect(live.status()).toBe('ended');
  });

  it('reconnects and re-subscribes after the connection drops', async () => {
    sockets[0]!.emit({ type: 'ready' });
    sockets[0]!.drop(1006);
    expect(live.status()).toBe('reconnecting');
    await tick();
    expect(sockets.length).toBe(2);
    sockets[1]!.emit({ type: 'ready' });
    expect(sockets[1]!.sent).toEqual([{ type: 'subscribe', icao24: ['aaaaa1', 'aaaaa2'] }]);
  });

  it('refreshes the session when the token expired (4401) and reconnects', async () => {
    sockets[0]!.drop(4401);
    TestBed.inject(HttpTestingController).expectOne('/api/auth/refresh').flush({ expiresAt: 'later' });
    await tick();
    expect(sockets.length).toBe(2);
  });

  it('stops with a message when the gateway rejects the selection', async () => {
    sockets[0]!.emit({ type: 'error', error: 'mixed_airlines', message: 'all selected flights must belong to the same airline' });
    expect(live.status()).toBe('error');
    expect(live.error()).toContain('same airline');
    sockets[0]!.drop(1000);
    await tick();
    expect(sockets.length).toBe(1);
  });
});
