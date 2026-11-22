//! Domain types shared by providers, the live store and the HTTP API.
//! Units are SI throughout (metres, m/s, degrees, unix seconds); the UI converts for display.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Opensky,
    AdsbLol,
    Simulator,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    /// IATA codes.
    pub origin: String,
    pub destination: String,
    /// Airport coordinates, when the provider knows them (lets the UI draw the planned route).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_pos: Option<[f64; 2]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_pos: Option<[f64; 2]>,
    /// Take-off time (unix seconds), when known. Not the same as `Flight::first_seen`, which is
    /// when *we* first observed the aircraft (it may already have been mid-route).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub departed_at: Option<i64>,
}

/// One position report as delivered by a provider (before airline matching).
#[derive(Debug, Clone, PartialEq)]
pub struct Observation {
    pub icao24: String,
    pub callsign: Option<String>,
    pub origin_country: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub altitude_m: Option<f64>,
    pub ground_speed_ms: Option<f64>,
    pub heading_deg: Option<f64>,
    pub vertical_rate_ms: Option<f64>,
    pub on_ground: bool,
    pub last_contact: i64,
    pub source: Source,
    pub registration: Option<String>,
    pub aircraft_type: Option<String>,
    pub route: Option<Route>,
}

/// An active airline flight as stored in Redis and returned by the API.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flight {
    pub icao24: String,
    pub callsign: String,
    pub airline_icao: String,
    pub flight_number: String,
    pub origin_country: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub altitude_m: Option<f64>,
    pub ground_speed_ms: Option<f64>,
    pub heading_deg: Option<f64>,
    pub vertical_rate_ms: Option<f64>,
    pub on_ground: bool,
    pub last_contact: i64,
    pub first_seen: i64,
    pub source: Source,
    pub registration: Option<String>,
    pub aircraft_type: Option<String>,
    pub route: Option<Route>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Airline {
    pub icao: String,
    pub iata: Option<String>,
    pub name: String,
    pub callsign: Option<String>,
    pub country: Option<String>,
}

/// Airline catalogue held in memory (loaded from Postgres, refreshed periodically).
#[derive(Debug, Clone, Default)]
pub struct Catalogue {
    by_icao: HashMap<String, Airline>,
}

impl Catalogue {
    pub fn new(airlines: impl IntoIterator<Item = Airline>) -> Self {
        Self { by_icao: airlines.into_iter().map(|a| (a.icao.clone(), a)).collect() }
    }

    pub fn get(&self, icao: &str) -> Option<&Airline> {
        self.by_icao.get(icao)
    }

    pub fn len(&self) -> usize {
        self.by_icao.len()
    }

    /// Case-insensitive search over ICAO, IATA and name, as (rank, airline) — lower rank is a
    /// better match: 0 exact code, 1 name prefix, 2 substring. Sorted by rank, then name.
    pub fn search(&self, query: &str, limit: usize) -> Vec<(u8, &Airline)> {
        let q = query.trim().to_uppercase();
        if q.is_empty() {
            return Vec::new();
        }
        let mut hits: Vec<(u8, &Airline)> = self
            .by_icao
            .values()
            .filter_map(|a| {
                let rank = if a.icao == q || a.iata.as_deref() == Some(q.as_str()) {
                    0
                } else if a.name.to_uppercase().starts_with(&q) {
                    1
                } else if a.name.to_uppercase().contains(&q) || a.icao.contains(&q) {
                    2
                } else {
                    return None;
                };
                Some((rank, a))
            })
            .collect();
        hits.sort_by(|x, y| x.0.cmp(&y.0).then_with(|| x.1.name.cmp(&y.1.name)));
        hits.truncate(limit);
        hits
    }

    /// Turns a provider observation into an airline flight, if its callsign belongs to a known airline.
    pub fn classify(&self, obs: &Observation, first_seen: i64) -> Option<Flight> {
        let callsign = obs.callsign.as_deref().map(str::trim).filter(|c| !c.is_empty())?;
        let (icao, number) = parse_airline_callsign(callsign)?;
        self.get(&icao)?;
        if !obs.lat.is_finite() || !obs.lon.is_finite() {
            return None;
        }
        Some(Flight {
            icao24: obs.icao24.to_lowercase(),
            callsign: callsign.to_uppercase(),
            airline_icao: icao,
            flight_number: number,
            origin_country: obs.origin_country.clone(),
            lat: obs.lat,
            lon: obs.lon,
            altitude_m: obs.altitude_m,
            ground_speed_ms: obs.ground_speed_ms,
            heading_deg: obs.heading_deg,
            vertical_rate_ms: obs.vertical_rate_ms,
            on_ground: obs.on_ground,
            last_contact: obs.last_contact,
            first_seen,
            source: obs.source,
            registration: obs.registration.clone(),
            aircraft_type: obs.aircraft_type.clone(),
            route: obs.route.clone(),
        })
    }
}

/// Splits an ICAO airline callsign like "AIC101" or "BAW12K" into ("AIC", "101"/"12K").
/// Registrations ("N123AB", "VTANB") and military/other formats return None.
pub fn parse_airline_callsign(raw: &str) -> Option<(String, String)> {
    let cs = raw.trim().to_ascii_uppercase();
    let bytes = cs.as_bytes();
    if !(4..=8).contains(&bytes.len())
        || !bytes[..3].iter().all(u8::is_ascii_uppercase)
        || !bytes[3].is_ascii_digit()
        || !bytes[3..].iter().all(u8::is_ascii_alphanumeric)
    {
        return None;
    }
    Some((cs[..3].to_string(), cs[3..].to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(callsign: &str) -> Observation {
        Observation {
            icao24: "8015AB".into(),
            callsign: Some(callsign.into()),
            origin_country: Some("India".into()),
            lat: 28.5,
            lon: 77.1,
            altitude_m: Some(10_000.0),
            ground_speed_ms: Some(230.0),
            heading_deg: Some(90.0),
            vertical_rate_ms: Some(0.0),
            on_ground: false,
            last_contact: 1_700_000_000,
            source: Source::Opensky,
            registration: None,
            aircraft_type: None,
            route: None,
        }
    }

    fn catalogue() -> Catalogue {
        Catalogue::new([
            Airline { icao: "AIC".into(), iata: Some("AI".into()), name: "Air India Limited".into(), callsign: Some("AIRINDIA".into()), country: Some("India".into()) },
            Airline { icao: "IGO".into(), iata: Some("6E".into()), name: "IndiGo Airlines".into(), callsign: Some("IFLY".into()), country: Some("India".into()) },
        ])
    }

    #[test]
    fn parses_airline_callsigns() {
        assert_eq!(parse_airline_callsign("AIC101  "), Some(("AIC".into(), "101".into())));
        assert_eq!(parse_airline_callsign("baw12k"), Some(("BAW".into(), "12K".into())));
        assert_eq!(parse_airline_callsign("AIC1GA"), Some(("AIC".into(), "1GA".into())));
    }

    #[test]
    fn rejects_registrations_and_junk() {
        for cs in ["N123AB", "VTANB", "AIC", "AI101", "AICX12", "AIC-101", "", "ABCDEFGHIJ1"] {
            assert_eq!(parse_airline_callsign(cs), None, "{cs:?} should not parse");
        }
    }

    #[test]
    fn classify_matches_known_airlines_only() {
        let cat = catalogue();
        let f = cat.classify(&obs("AIC101 "), 42).expect("AIC is known");
        assert_eq!((f.airline_icao.as_str(), f.flight_number.as_str(), f.icao24.as_str()), ("AIC", "101", "8015ab"));
        assert_eq!(f.first_seen, 42);
        assert!(cat.classify(&obs("ZZZ101"), 0).is_none(), "unknown airline");
        assert!(cat.classify(&obs("VTANB"), 0).is_none(), "registration callsign");
    }

    #[test]
    fn search_ranks_exact_codes_first() {
        let cat = catalogue();
        assert_eq!(cat.search("6e", 10)[0], (0, cat.get("IGO").unwrap()));
        assert_eq!(cat.search("ind", 10).len(), 2, "matches Air India and IndiGo");
        assert_eq!(cat.search("india", 10).len(), 1, "IndiGo does not contain 'india'");
        assert_eq!(cat.search("air ind", 10)[0].1.icao, "AIC");
        assert!(cat.search("   ", 10).is_empty());
    }
}
