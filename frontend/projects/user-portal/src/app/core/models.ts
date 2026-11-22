/** Shapes returned by tracking-service (via the gateway). Units are SI: metres, m/s, degrees, unix seconds. */

export interface Airline {
  icao: string;
  iata: string | null;
  name: string;
  callsign: string | null;
  country: string | null;
  activeFlights: number;
}

export type FlightSource = 'opensky' | 'adsbLol' | 'simulator';

export interface Flight {
  icao24: string;
  callsign: string;
  airlineIcao: string;
  flightNumber: string;
  originCountry: string | null;
  lat: number;
  lon: number;
  altitudeM: number | null;
  groundSpeedMs: number | null;
  headingDeg: number | null;
  verticalRateMs: number | null;
  onGround: boolean;
  lastContact: number;
  firstSeen: number;
  source: FlightSource;
  registration: string | null;
  aircraftType: string | null;
  route: Route | null;
}

export interface Route {
  /** IATA codes */
  origin: string;
  destination: string;
  /** [lat, lon] of the airports, when known */
  originPos?: [number, number];
  destinationPos?: [number, number];
  /** Take-off time (unix s), when known. `Flight.firstSeen` is only when tracking first saw the aircraft. */
  departedAt?: number;
}

/** [lat, lon, altitudeM, unixSeconds] */
export type TrailPoint = [number, number, number, number];

export interface FlightDetail {
  flight: Flight;
  airline: Omit<Airline, 'activeFlights'> | null;
  trail?: TrailPoint[];
}

export interface AirlineFlights {
  airline: Airline;
  flights: Flight[];
}
