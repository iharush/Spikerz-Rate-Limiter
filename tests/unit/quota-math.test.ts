import { nextAllowedAt, statusFor, windowUsage } from '../../packages/quota-math/src/index.js';

describe('rolling quota math', () => {
  it.each([
    [89, 100, 'OK'],
    [90, 100, 'Warning'],
    [99, 100, 'Warning'],
    [100, 100, 'Exceeded'],
    [140, 100, 'Exceeded'],
  ])('labels %i of %i as %s', (used, capacity, status) => {
    expect(statusFor(used as number, capacity as number)).toBe(status);
  });
  it('excludes the lower boundary and retains later bursts', () => {
    const now = 10_000_000;
    const admissions = [...Array(60).fill(now - 3600000), ...Array(40).fill(now - 1800000)];
    expect(windowUsage(admissions, now)).toHaveLength(40);
  });
  it('waits for enough requests after a capacity reduction', () => {
    const now = 10_000_000;
    const admissions = Array.from({ length: 90 }, (_, i) => now - 3000000 + i * 1000);
    expect(nextAllowedAt(admissions, 50, now)).toBe(admissions[40] + 3600000);
    expect(nextAllowedAt(admissions, 100, now)).toBeNull();
  });
});
