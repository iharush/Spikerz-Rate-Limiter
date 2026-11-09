import { z } from 'zod';

export type RateStatus = 'OK' | 'Warning' | 'Exceeded';
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('limit'), value: z.number().int().min(1).max(1_000_000) }).strict(),
  z
    .object({ type: z.literal('extra-quota'), value: z.number().int().min(0).max(1_000_000) })
    .strict(),
  z.object({ type: z.literal('bypass'), value: z.boolean() }).strict(),
  z.object({ type: z.literal('reset') }).strict(),
]);
export type AdminAction = z.infer<typeof actionSchema>;
export interface Command {
  commandId: string;
  userId: string;
  action: AdminAction;
}
export interface UserState {
  userId: string;
  userVersion: number;
  policyRevision: number;
  baseLimit: number;
  extraQuota: number;
  capacity: number;
  used: number;
  remaining: number;
  bypassEnabled: boolean;
  nextChangeAt: string | null;
  nextAllowedAt: string | null;
  lastManualResetAt: string | null;
  lastRequestAt: string | null;
  asOf: string;
  status: RateStatus;
}
export interface RateEvent extends UserState {
  eventId: string;
  kind: 'decision' | 'state';
  allowed: boolean | null;
  bypassed: boolean;
  quotaCharged: boolean;
  requestId: string | null;
}
export const eventSchema = z
  .object({
    eventId: z.uuid(),
    userId: z.string().min(1).max(300),
    userVersion: z.number().int().positive(),
    policyRevision: z.number().int().nonnegative(),
    baseLimit: z.number().int().positive(),
    extraQuota: z.number().int().nonnegative(),
    capacity: z.number().int().positive(),
    used: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    bypassEnabled: z.boolean(),
    nextChangeAt: z.iso.datetime({ offset: true }).nullable(),
    nextAllowedAt: z.iso.datetime({ offset: true }).nullable(),
    lastManualResetAt: z.iso.datetime({ offset: true }).nullable(),
    lastRequestAt: z.iso.datetime({ offset: true }).nullable(),
    asOf: z.iso.datetime({ offset: true }),
    status: z.enum(['OK', 'Warning', 'Exceeded']),
    kind: z.enum(['decision', 'state']),
    allowed: z.boolean().nullable(),
    bypassed: z.boolean(),
    quotaCharged: z.boolean(),
    requestId: z.uuid().nullable(),
  })
  .strict();
// Both quota WebSocket events tell the browser which HTTP views to refresh.
export interface RateChange {
  userId: string;
}
export interface Summary {
  totalUsers: number;
  nearLimitPercent: number;
  deniedToday: number;
  asOf: string;
}

export const commandReceiptSchema = z
  .object({
    commandId: z.uuid(),
    revision: z.number().int().positive(),
    state: eventSchema,
  })
  .strict();
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;
