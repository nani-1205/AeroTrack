import { MAX_EXTRAPOLATION_S, destination, predict } from './geo';

describe('dead reckoning', () => {
  it('moves north along the meridian', () => {
    const p = destination(0, 0, 0, 111_195); // ≈ 1° of latitude
    expect(p.lat).toBeCloseTo(1, 3);
    expect(p.lon).toBeCloseTo(0, 6);
  });

  it('extrapolates by speed × elapsed time', () => {
    const k = { lat: 28.5, lon: 77.1, headingDeg: 90, groundSpeedMs: 250, lastContact: 1000 };
    const p = predict(k, 1010); // 2.5 km east
    expect(p.lat).toBeCloseTo(28.5, 3);
    expect(p.lon).toBeGreaterThan(77.1);
  });

  it('does not extrapolate without speed/heading, backwards in time, or forever', () => {
    const base = { lat: 10, lon: 20, headingDeg: 45, groundSpeedMs: 200, lastContact: 1000 };
    expect(predict({ ...base, headingDeg: null }, 1100)).toEqual({ lat: 10, lon: 20 });
    expect(predict({ ...base, groundSpeedMs: 0 }, 1100)).toEqual({ lat: 10, lon: 20 });
    expect(predict(base, 900)).toEqual({ lat: 10, lon: 20 });
    expect(predict(base, 1000 + 10 * MAX_EXTRAPOLATION_S)).toEqual(predict(base, 1000 + MAX_EXTRAPOLATION_S));
  });

  it('wraps longitude across the antimeridian', () => {
    const p = destination(0, 179.9, 90, 50_000);
    expect(p.lon).toBeLessThan(-179);
  });
});
