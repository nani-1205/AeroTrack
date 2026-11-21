import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import type { Flight } from '../../core/models';
import { parseIds } from '../track/track';
import { FlightsPage } from './flights';

const flight = (i: number): Flight => ({
  icao24: `a0000${i}`, callsign: `AIC${100 + i}`, airlineIcao: 'AIC', flightNumber: String(100 + i), originCountry: 'India',
  lat: 20, lon: 77, altitudeM: 10_000, groundSpeedMs: 240, headingDeg: 90, verticalRateMs: 0, onGround: false,
  lastContact: 1000, firstSeen: 400, source: 'simulator', registration: null, aircraftType: 'A320',
  route: { origin: 'DEL', destination: 'BOM' },
});

describe('FlightsPage', () => {
  let navigated: unknown[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FlightsPage],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    navigated = [];
    TestBed.inject(Router).navigate = async (cmds, extras) => (navigated.push({ cmds, extras }), true);
  });

  async function render() {
    const fixture = TestBed.createComponent(FlightsPage);
    fixture.componentRef.setInput('icao', 'AIC');
    await fixture.whenStable();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/airlines/AIC/flights')
      .flush({ airline: { icao: 'AIC', iata: 'AI', name: 'Air India Limited', callsign: null, country: 'India', activeFlights: 7 }, flights: [1, 2, 3, 4, 5, 6, 7].map(flight) });
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('lists the airline flights', async () => {
    const { el } = await render();
    expect(el.querySelector('h1')?.textContent).toContain('Air India Limited');
    expect(el.querySelectorAll('tbody tr').length).toBe(7);
    expect(el.querySelector('tbody tr')?.textContent).toContain('DEL → BOM');
  });

  it('allows at most 5 selected flights and tracks them together', async () => {
    const { fixture, el } = await render();
    const boxes = () => [...el.querySelectorAll<HTMLInputElement>('tbody input[type=checkbox]')];
    for (const box of boxes().slice(0, 6)) {
      box.click();
      fixture.detectChanges();
    }
    expect(boxes().filter((b) => b.checked).length).toBe(5);
    expect(boxes()[5]!.disabled).toBe(true);
    expect(el.querySelector('.selection')?.textContent).toContain('5 of 5 selected');

    el.querySelector<HTMLButtonElement>('.selection .btn-primary')!.click();
    expect(navigated).toEqual([{ cmds: ['/track'], extras: { queryParams: { ids: 'a00001,a00002,a00003,a00004,a00005' } } }]);
  });

  it('filters by callsign or airport', async () => {
    const { fixture, el } = await render();
    const input = el.querySelector<HTMLInputElement>('input[type=search]')!;
    input.value = 'aic103';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(el.querySelectorAll('tbody tr').length).toBe(1);
  });
});

describe('parseIds', () => {
  it('accepts 1–5 icao24 codes and normalises them', () => {
    expect(parseIds('AAAAA1, aaaaa2,aaaaa1')).toEqual(['aaaaa1', 'aaaaa2']);
    expect(parseIds('a1,b2,c3,d4,e5,f6')).toBeNull();
    expect(parseIds('aaaaa1,aaaaa2,aaaaa3,aaaaa4,aaaaa5,aaaaa6')).toBeNull();
    expect(parseIds('')).toBeNull();
    expect(parseIds(undefined)).toBeNull();
    expect(parseIds('not-hex')).toBeNull();
  });
});
