//! Great-circle helpers (spherical Earth). Degrees in, degrees/metres out.

pub const EARTH_RADIUS_M: f64 = 6_371_000.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LatLon {
    pub lat: f64,
    pub lon: f64,
}

impl LatLon {
    pub const fn new(lat: f64, lon: f64) -> Self {
        Self { lat, lon }
    }
}

/// Haversine distance in metres.
pub fn distance_m(a: LatLon, b: LatLon) -> f64 {
    let (p1, p2) = (a.lat.to_radians(), b.lat.to_radians());
    let dp = (b.lat - a.lat).to_radians();
    let dl = (b.lon - a.lon).to_radians();
    let h = (dp / 2.0).sin().powi(2) + p1.cos() * p2.cos() * (dl / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().asin()
}

/// Initial bearing from `a` towards `b`, 0..360° (0 = north, 90 = east).
pub fn bearing_deg(a: LatLon, b: LatLon) -> f64 {
    let (p1, p2) = (a.lat.to_radians(), b.lat.to_radians());
    let dl = (b.lon - a.lon).to_radians();
    let y = dl.sin() * p2.cos();
    let x = p1.cos() * p2.sin() - p1.sin() * p2.cos() * dl.cos();
    (y.atan2(x).to_degrees() + 360.0) % 360.0
}

/// Point at `fraction` (0..=1) of the way along the great circle from `a` to `b`.
pub fn intermediate(a: LatLon, b: LatLon, fraction: f64) -> LatLon {
    let d = distance_m(a, b) / EARTH_RADIUS_M;
    if d < 1e-12 {
        return a;
    }
    let f = fraction.clamp(0.0, 1.0);
    let (p1, l1) = (a.lat.to_radians(), a.lon.to_radians());
    let (p2, l2) = (b.lat.to_radians(), b.lon.to_radians());
    let wa = ((1.0 - f) * d).sin() / d.sin();
    let wb = (f * d).sin() / d.sin();
    let x = wa * p1.cos() * l1.cos() + wb * p2.cos() * l2.cos();
    let y = wa * p1.cos() * l1.sin() + wb * p2.cos() * l2.sin();
    let z = wa * p1.sin() + wb * p2.sin();
    LatLon::new(z.atan2((x * x + y * y).sqrt()).to_degrees(), y.atan2(x).to_degrees())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEL: LatLon = LatLon::new(28.5562, 77.1000);
    const BOM: LatLon = LatLon::new(19.0896, 72.8656);

    #[test]
    fn distance_delhi_mumbai_is_about_1150_km() {
        let d = distance_m(DEL, BOM) / 1000.0;
        assert!((1130.0..1160.0).contains(&d), "got {d} km");
    }

    #[test]
    fn bearings_point_the_right_way() {
        assert!(bearing_deg(LatLon::new(0.0, 0.0), LatLon::new(10.0, 0.0)).abs() < 1e-9); // north
        assert!((bearing_deg(LatLon::new(0.0, 0.0), LatLon::new(0.0, 10.0)) - 90.0).abs() < 1e-9); // east
        let south_west = bearing_deg(DEL, BOM);
        assert!((180.0..270.0).contains(&south_west), "DEL→BOM should be SSW, got {south_west}");
    }

    #[test]
    fn intermediate_hits_endpoints_and_midpoint() {
        let start = intermediate(DEL, BOM, 0.0);
        let end = intermediate(DEL, BOM, 1.0);
        assert!(distance_m(start, DEL) < 1.0 && distance_m(end, BOM) < 1.0);
        let mid = intermediate(DEL, BOM, 0.5);
        let total = distance_m(DEL, BOM);
        assert!((distance_m(DEL, mid) - total / 2.0).abs() < 10.0);
    }
}
