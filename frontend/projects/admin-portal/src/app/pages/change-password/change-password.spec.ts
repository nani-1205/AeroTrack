import { passwordStrength } from './change-password';

describe('passwordStrength', () => {
  it('scores length, mixed case, digits and symbols', () => {
    expect(passwordStrength('')).toEqual({ score: 0, label: '' });
    expect(passwordStrength('short').score).toBe(0);
    expect(passwordStrength('alllowercase').score).toBe(1);
    expect(passwordStrength('MixedCaseLetters').score).toBe(3);
    expect(passwordStrength('Mixed-Case-1234-Pass')).toEqual({ score: 4, label: 'Strong' });
  });

  it('never rates a password shorter than the minimum above "Weak"', () => {
    expect(passwordStrength('Ab1!').score).toBeLessThanOrEqual(1);
  });
});
