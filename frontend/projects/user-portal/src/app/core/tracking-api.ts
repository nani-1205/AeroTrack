import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { API_BASE_URL } from '@aerotrack/shared';
import { firstValueFrom } from 'rxjs';
import type { Airline, AirlineFlights, FlightDetail } from './models';

@Injectable({ providedIn: 'root' })
export class TrackingApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);

  /** Without a query: airlines with active flights, busiest first. With a query: ranked catalogue search. */
  async airlines(search = '', limit = 100): Promise<Airline[]> {
    let params = new HttpParams().set('limit', limit);
    if (search.trim()) params = params.set('search', search.trim());
    const res = await firstValueFrom(this.http.get<{ airlines: Airline[] }>(`${this.base}/airlines`, { params }));
    return res.airlines;
  }

  airlineFlights(icao: string): Promise<AirlineFlights> {
    return firstValueFrom(this.http.get<AirlineFlights>(`${this.base}/airlines/${encodeURIComponent(icao)}/flights`));
  }

  flight(icao24: string, trail = false): Promise<FlightDetail> {
    const params = new HttpParams().set('trail', trail);
    return firstValueFrom(this.http.get<FlightDetail>(`${this.base}/flights/${encodeURIComponent(icao24)}`, { params }));
  }
}
