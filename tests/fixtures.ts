import { randomUUID } from 'node:crypto';
import type { RateEvent } from '../packages/contracts/src/index.js';

export function decision(overrides: Partial<RateEvent> = {}): RateEvent {
  return {
    eventId: randomUUID(),
    userId: '["spikerz-demo","alice"]',
    userVersion: 1,
    policyRevision: 0,
    baseLimit: 100,
    extraQuota: 0,
    capacity: 100,
    used: 1,
    remaining: 99,
    bypassEnabled: false,
    nextChangeAt: '2026-11-04T11:00:00.000Z',
    nextAllowedAt: null,
    lastManualResetAt: null,
    lastRequestAt: '2026-11-04T10:00:00.000Z',
    asOf: '2026-11-04T10:00:00.000Z',
    status: 'OK',
    kind: 'decision',
    allowed: true,
    bypassed: false,
    quotaCharged: true,
    requestId: randomUUID(),
    ...overrides,
  };
}
