import type { RateStatus } from '../../contracts/src/index.js';

export function statusFor(used: number, capacity: number): RateStatus {
  return used >= capacity ? 'Exceeded' : used >= capacity * 0.9 ? 'Warning' : 'OK';
}

// The boundary is exclusive. A charge exactly one hour old has expired.
export function windowUsage(admissions: number[], now: number): number[] {
  return admissions.filter((time) => time > now - 3_600_000 && time <= now).sort((a, b) => a - b);
}

// Capacity reductions may require several charges to expire before admission.
export function nextAllowedAt(admissions: number[], capacity: number, now: number): number | null {
  const current = windowUsage(admissions, now);
  return current.length < capacity ? null : current[current.length - capacity] + 3_600_000;
}
