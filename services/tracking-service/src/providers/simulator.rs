//! Deterministic flight simulator for offline development and tests.
//! Flights fly great-circle routes between real airports with a climb/cruise/descent profile
//! and start a new leg from their destination on arrival.

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

use super::unix_now;
use crate::config;
use crate::geo::{self, LatLon};
use crate::model::{Observation, Route, Source};

/// (IATA, latitude, longitude)
const AIRPORTS: &[(&str, f64, f64)] = &[
    ("DEL", 28.5562, 77.1000), ("BOM", 19.0896, 72.8656), ("BLR", 13.1986, 77.7066), ("MAA", 12.9941, 80.1709),
    ("HYD", 17.2403, 78.4294), ("CCU", 22.6547, 88.4467), ("DXB", 25.2532, 55.3657), ("DOH", 25.2731, 51.6081),
    ("AUH", 24.4330, 54.6511), ("LHR", 51.4700, -0.4543), ("CDG", 49.0097, 2.5479), ("FRA", 50.0379, 8.5622),
    ("AMS", 52.3105, 4.7683), ("MUC", 48.3538, 11.7861), ("IST", 41.2753, 28.7519), ("MAD", 40.4983, -3.5676),
    ("FCO", 41.8003, 12.2389), ("ZRH", 47.4582, 8.5555), ("JFK", 40.6413, -73.7781), ("LAX", 33.9416, -118.4085),
    ("ORD", 41.9742, -87.9073), ("ATL", 33.6407, -84.4277), ("DFW", 32.8998, -97.0403), ("SFO", 37.6213, -122.3790),
    ("SEA", 47.4502, -122.3088), ("MIA", 25.7959, -80.2870), ("YYZ", 43.6777, -79.6248), ("GRU", -23.4356, -46.4731),
    ("SIN", 1.3644, 103.9915), ("HKG", 22.3080, 113.9185), ("NRT", 35.7720, 140.3929), ("HND", 35.5494, 139.7798),
    ("ICN", 37.4602, 126.4407), ("BKK", 13.6900, 100.7501), ("KUL", 2.7456, 101.7099), ("SYD", -33.9399, 151.1753),
    ("MEL", -37.6690, 144.8410), ("JNB", -26.1392, 28.2460), ("CAI", 30.1219, 31.4056), ("PEK", 40.0799, 116.6031),
];

const AIRCRAFT_TYPES: &[&str] = &["A320", "A321", "B738", "B38M", "A359", "B789", "B77W", "A388"];
const MIN_LEG_M: f64 = 600_000.0;
const CLIMB_M: f64 = 180_000.0; // horizontal distance to reach cruise / start descent

struct SimFlight {
    icao24: String,
    callsign: String,
    aircraft_type: String,
    origin: usize,
    destination: usize,
    leg_m: f64,
    progress: f64,
    speed_ms: f64,
    cruise_m: f64,
    altitude_m: f64,
}

pub struct Simulator {
    flights: Vec<SimFlight>,
    rng: StdRng,
    last_tick: Option<std::time::Instant>,
}

fn airport(i: usize) -> LatLon {
    LatLon::new(AIRPORTS[i].1, AIRPORTS[i].2)
}

impl Simulator {
    pub fn new(cfg: &config::Simulator) -> Self {
        let mut rng = StdRng::seed_from_u64(cfg.seed);
        let mut flights = Vec::new();
        for (a, airline) in cfg.airlines.iter().enumerate() {
            for n in 0..cfg.flights_per_airline {
                let (origin, destination, leg_m) = pick_route(&mut rng, None);
                let cruise_m = rng.random_range(9_500.0..12_000.0);
                let progress = rng.random_range(0.03..0.97);
                let mut f = SimFlight {
                    // Stable, unique per airline/index; lowercase hex like real ICAO 24-bit addresses.
                    icao24: format!("{:06x}", 0xA0_0000 + (a as u32) * 0x1000 + n),
                    callsign: format!("{}{}", airline.to_uppercase(), 100 + n * 7 + a as u32 % 7),
                    aircraft_type: AIRCRAFT_TYPES[(a + n as usize) % AIRCRAFT_TYPES.len()].to_string(),
                    origin,
                    destination,
                    leg_m,
                    progress,
                    speed_ms: rng.random_range(220.0..255.0),
                    cruise_m,
                    altitude_m: 0.0,
                };
                f.altitude_m = target_altitude(&f);
                flights.push(f);
            }
        }
        Self { flights, rng, last_tick: None }
    }

    /// Advances the world by `dt_s` seconds.
    pub fn advance(&mut self, dt_s: f64) {
        for f in &mut self.flights {
            f.progress += f.speed_ms * dt_s / f.leg_m;
            if f.progress >= 1.0 {
                let (origin, destination, leg_m) = pick_route(&mut self.rng, Some(f.destination));
                (f.origin, f.destination, f.leg_m, f.progress) = (origin, destination, leg_m, 0.0);
            }
        }
    }

    /// Advances by wall-clock time since the previous snapshot, then reports every flight.
    pub fn snapshot(&mut self) -> Vec<Observation> {
        let now = std::time::Instant::now();
        if let Some(prev) = self.last_tick.replace(now) {
            self.advance(now.duration_since(prev).as_secs_f64());
        }
        self.observations(unix_now())
    }

    pub fn observations(&mut self, now: i64) -> Vec<Observation> {
        self.flights
            .iter_mut()
            .map(|f| {
                let (from, to) = (airport(f.origin), airport(f.destination));
                let pos = geo::intermediate(from, to, f.progress);
                let new_alt = target_altitude(f);
                let vertical = (new_alt - f.altitude_m).clamp(-15.0, 15.0);
                f.altitude_m = new_alt;
                Observation {
                    icao24: f.icao24.clone(),
                    callsign: Some(f.callsign.clone()),
                    origin_country: None,
                    lat: pos.lat,
                    lon: pos.lon,
                    altitude_m: Some(new_alt.round()),
                    ground_speed_ms: Some(f.speed_ms),
                    heading_deg: Some(geo::bearing_deg(pos, to)),
                    vertical_rate_ms: Some(vertical),
                    on_ground: false,
                    last_contact: now,
                    source: Source::Simulator,
                    registration: None,
                    aircraft_type: Some(f.aircraft_type.clone()),
                    route: Some(Route {
                        origin: AIRPORTS[f.origin].0.to_string(),
                        destination: AIRPORTS[f.destination].0.to_string(),
                    }),
                }
            })
            .collect()
    }
}

fn target_altitude(f: &SimFlight) -> f64 {
    let flown = f.progress * f.leg_m;
    let remaining = f.leg_m - flown;
    let ratio = (flown.min(remaining) / CLIMB_M).min(1.0);
    (f.cruise_m * ratio).max(450.0)
}

fn pick_route(rng: &mut StdRng, from: Option<usize>) -> (usize, usize, f64) {
    loop {
        let origin = from.unwrap_or_else(|| rng.random_range(0..AIRPORTS.len()));
        let destination = rng.random_range(0..AIRPORTS.len());
        let leg_m = geo::distance_m(airport(origin), airport(destination));
        if origin != destination && leg_m >= MIN_LEG_M {
            return (origin, destination, leg_m);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(seed: u64) -> config::Simulator {
        config::Simulator { airlines: vec!["AIC".into(), "BAW".into()], flights_per_airline: 5, tick_seconds: 2, seed }
    }

    #[test]
    fn same_seed_same_world() {
        let a = Simulator::new(&cfg(7)).observations(1000);
        let b = Simulator::new(&cfg(7)).observations(1000);
        assert_eq!(a, b);
        assert_ne!(a, Simulator::new(&cfg(8)).observations(1000));
    }

    #[test]
    fn produces_valid_airline_flights() {
        let obs = Simulator::new(&cfg(1)).observations(1000);
        assert_eq!(obs.len(), 10);
        let mut ids: Vec<_> = obs.iter().map(|o| o.icao24.clone()).collect();
        ids.dedup();
        assert_eq!(ids.len(), 10, "icao24 must be unique");
        for o in &obs {
            let cs = o.callsign.as_deref().unwrap();
            assert!(crate::model::parse_airline_callsign(cs).is_some(), "{cs} must be an airline callsign");
            assert!((-90.0..=90.0).contains(&o.lat) && (-180.0..=180.0).contains(&o.lon));
            assert!((450.0..=12_000.0).contains(&o.altitude_m.unwrap()));
            assert!((0.0..360.0).contains(&o.heading_deg.unwrap()));
        }
    }

    #[test]
    fn flights_move_towards_their_destination() {
        let mut sim = Simulator::new(&cfg(3));
        let before = sim.observations(0);
        sim.advance(60.0);
        let after = sim.observations(60);
        for (b, a) in before.iter().zip(&after) {
            let moved = geo::distance_m(LatLon::new(b.lat, b.lon), LatLon::new(a.lat, a.lon));
            // ~220–255 m/s for 60 s, unless the leg just ended and a new one started.
            assert!(moved < 16_000.0, "moved {moved} m in 60 s");
            if b.route == a.route {
                assert!(moved > 12_000.0, "moved only {moved} m in 60 s");
            }
        }
    }
}
