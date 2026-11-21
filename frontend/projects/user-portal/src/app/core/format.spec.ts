import { ago, altitude, duration, heading, speed, verticalRate } from './format';

describe('format', () => {
  it('converts metres to rounded feet', () => {
    expect(altitude(10_668)).toBe('35,000 ft');
    expect(altitude(0)).toBe('0 ft');
    expect(altitude(null)).toBe('—');
  });

  it('converts m/s to knots', () => {
    expect(speed(245)).toBe('476 kt');
    expect(speed(undefined)).toBe('—');
  });

  it('shows climb/descent in ft/min and "level" when flat', () => {
    expect(verticalRate(5.08)).toBe('+1,000 ft/min');
    expect(verticalRate(-2.6)).toBe('−500 ft/min');
    expect(verticalRate(0.2)).toBe('level');
  });

  it('adds a compass point to headings', () => {
    expect(heading(0)).toBe('0° N');
    expect(heading(105)).toBe('105° ESE');
    expect(heading(359.6)).toBe('0° N');
    expect(heading(-90)).toBe('270° W');
  });

  it('formats durations and ages', () => {
    expect(duration(45)).toBe('45s');
    expect(duration(14 * 60 + 5)).toBe('14m');
    expect(duration(2 * 3600 + 5 * 60)).toBe('2h 05m');
    expect(ago(100, 101)).toBe('just now');
    expect(ago(100, 112)).toBe('12 s ago');
    expect(ago(0, 600)).toBe('10 min ago');
  });
});
