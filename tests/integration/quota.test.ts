import 'reflect-metadata';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { DemoController } from '../../apps/data-api/src/app.js';
import { QuotaRepository } from '../../apps/data-api/src/repository.js';
import { RateLimitInterceptor } from '../../apps/data-api/src/interceptor.js';
import { TokenVerifier, UserGuard } from '../../packages/auth/src/index.js';
import {
  eventSchema,
  type AdminAction,
  type RateEvent,
} from '../../packages/contracts/src/index.js';

const url =
  process.env.TEST_DATA_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55431/spikerz_test';
const pool = new Pool({ connectionString: url, max: 30 });
const fresh = () => `test-${randomUUID()}`;
const consume = async (user: string, request = randomUUID()) =>
  (await pool.query('SELECT consume_quota($1,$2) AS event', [user, request])).rows[0]
    .event as RateEvent;
const apply = async (user: string, action: AdminAction, commandId = randomUUID()) =>
  (
    await pool.query('SELECT apply_quota_command($1) AS receipt', [
      { commandId, userId: user, action },
    ])
  ).rows[0].receipt;
async function seed(user: string, ages: number[], baseLimit = 100) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO user_state(user_id,base_limit,quota_balance) VALUES($1,$2,$3)',
      [user, baseLimit, baseLimit - ages.length],
    );
    // A single sampled DB timestamp gives deterministic equal timestamps/boundaries.
    await client.query(
      `INSERT INTO quota_log SELECT gen_random_uuid(),$1,0,clock_timestamp()-age*interval '1 millisecond' FROM unnest($2::double precision[]) age`,
      [user, ages],
    );
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}
async function invariant(user: string) {
  const row = (
    await pool.query(
      `SELECT s.*,count(q.request_id)::integer AS live FROM user_state s LEFT JOIN quota_log q
    ON q.user_id=s.user_id AND q.quota_epoch=s.quota_epoch WHERE s.user_id=$1 GROUP BY s.user_id`,
      [user],
    )
  ).rows[0];
  expect(row.quota_balance).toBe(row.base_limit + row.extra_quota - row.live);
  return row;
}
beforeAll(async () => {
  if (!new URL(url).pathname.endsWith('_test'))
    throw new Error('Integration tests require a database ending in _test');
  await pool.query(await readFile('infra/sql/data.sql', 'utf8'));
});
afterAll(() => pool.end());

describe('real PostgreSQL quota transactions', () => {
  it('admits first and 100th, denies 101st, with one event per decision', async () => {
    const user = fresh();
    const first = await consume(user);
    expect(first.remaining).toBe(99);
    eventSchema.parse(first);
    for (let i = 1; i < 100; i++) await consume(user);
    const denied = await consume(user);
    expect(denied).toMatchObject({ allowed: false, remaining: 0, used: 100, quotaCharged: false });
    expect(denied.nextAllowedAt).not.toBeNull();
    await invariant(user);
    expect(
      (await pool.query('SELECT count(*)::integer AS n FROM event_outbox WHERE user_id=$1', [user]))
        .rows[0].n,
    ).toBe(101);
  });
  it('serializes 200 simultaneous first requests without lost records', async () => {
    const user = fresh();
    const events = await Promise.all(Array.from({ length: 200 }, () => consume(user)));
    expect(events.filter((event) => event.allowed)).toHaveLength(100);
    expect(new Set(events.map((event) => event.userVersion)).size).toBe(200);
    await invariant(user);
  });
  it('accounts for different users independently', async () => {
    const events = await Promise.all(Array.from({ length: 10 }, () => consume(fresh())));
    expect(events.every((event) => event.remaining === 99)).toBe(true);
  });
  it('reclaims exact one-hour entries and retains the later burst', async () => {
    const user = fresh();
    await seed(user, [...Array(60).fill(3600000), ...Array(40).fill(1800000)]);
    expect(await consume(user)).toMatchObject({ used: 41, remaining: 59 });
    await invariant(user);
  });
  it('gives simultaneous timestamps separate charge identities', async () => {
    const user = fresh();
    await seed(user, Array(100).fill(1000));
    expect(await consume(user)).toMatchObject({ allowed: false, used: 100 });
  });
  it('reclaims expired entries once across requests and expiry refreshes', async () => {
    const user = fresh();
    await seed(user, Array(100).fill(3600010));
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        i % 2 ? consume(user) : pool.query('SELECT refresh_quota($1)', [user]),
      ),
    );
    expect((await invariant(user)).quota_balance).toBe(85);
  });
  it('samples time after waiting for a user write across an expiry boundary', async () => {
    const user = fresh();
    await seed(user, [3599700], 1);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('UPDATE user_state SET event_version=event_version WHERE user_id=$1', [
      user,
    ]);
    const pending = consume(user);
    await blocker.query('SELECT pg_sleep(0.4)');
    await blocker.query('COMMIT');
    blocker.release();
    expect(await pending).toMatchObject({ allowed: true, remaining: 0 });
    await invariant(user);
  });
  it('rolls reclamation and decrement back if request-log insertion fails', async () => {
    const user = fresh();
    await seed(user, [3600010, 1000]);
    const id = (
      await pool.query(
        'SELECT request_id FROM quota_log WHERE user_id=$1 ORDER BY admitted_at DESC LIMIT 1',
        [user],
      )
    ).rows[0].request_id;
    await expect(consume(user, id)).rejects.toThrow();
    const row = await invariant(user);
    expect(row.quota_balance).toBe(98);
    expect(
      (await pool.query('SELECT count(*)::integer AS n FROM event_outbox WHERE user_id=$1', [user]))
        .rows[0].n,
    ).toBe(0);
  });
  it('rolls the whole transaction back if event insertion fails', async () => {
    const user = fresh();
    await seed(user, [3600010]);
    await pool.query(
      `INSERT INTO event_outbox(event_id,user_id,user_version,payload) VALUES(gen_random_uuid(),$1,1,'{}')`,
      [user],
    );
    await expect(consume(user)).rejects.toThrow();
    expect((await invariant(user)).quota_balance).toBe(99);
    expect(
      (await pool.query('SELECT count(*)::integer AS n FROM quota_log WHERE user_id=$1', [user]))
        .rows[0].n,
    ).toBe(1);
  });
  it('keeps 1,000 bypassed requests observable and leaves 10 quota units', async () => {
    const user = fresh();
    await seed(user, Array(90).fill(1000));
    await apply(user, { type: 'bypass', value: true });
    const events = await Promise.all(Array.from({ length: 1000 }, () => consume(user)));
    expect(
      events.every((event) => event.bypassed && !event.quotaCharged && event.remaining === 10),
    ).toBe(true);
    await apply(user, { type: 'bypass', value: false });
    expect((await invariant(user)).quota_balance).toBe(10);
    expect((await consume(user)).remaining).toBe(9);
  });
  it('ages previous charges out normally during bypass', async () => {
    const user = fresh();
    await seed(user, Array(90).fill(3600000));
    await apply(user, { type: 'bypass', value: true });
    expect(await consume(user)).toMatchObject({ remaining: 100, used: 0, bypassed: true });
    await invariant(user);
  });
  it('preserves negative debt and calculates the 41st expiry after a reduction', async () => {
    const user = fresh();
    await seed(
      user,
      Array.from({ length: 90 }, (_, i) => 3000000 - i * 1000),
    );
    const receipt = await apply(user, { type: 'limit', value: 50 });
    expect(receipt.state).toMatchObject({ used: 90, capacity: 50, remaining: 0 });
    expect((await invariant(user)).quota_balance).toBe(-40);
    const expected = (
      await pool.query(
        "SELECT admitted_at+interval '1 hour' AS at FROM quota_log WHERE user_id=$1 ORDER BY admitted_at OFFSET 40 LIMIT 1",
        [user],
      )
    ).rows[0].at;
    expect(Date.parse((await consume(user)).nextAllowedAt!)).toBe(expected.getTime());
  });
  it('persists extra quota and bypass across reset and a new pool', async () => {
    const user = fresh();
    await apply(user, { type: 'extra-quota', value: 50 });
    await apply(user, { type: 'bypass', value: true });
    await apply(user, { type: 'reset' });
    const connection = new Pool({ connectionString: url });
    const event = (
      await connection.query('SELECT consume_quota($1,$2) AS event', [user, randomUUID()])
    ).rows[0].event;
    await connection.end();
    expect(event).toMatchObject({
      extraQuota: 50,
      capacity: 150,
      bypassEnabled: true,
      remaining: 150,
      used: 0,
    });
    expect(event.lastManualResetAt).not.toBeNull();
  });
  it('removes extra quota without rewriting charged usage', async () => {
    const user = fresh();
    await seed(user, Array(90).fill(1000), 50);
    await apply(user, { type: 'extra-quota', value: 50 });
    await apply(user, { type: 'extra-quota', value: 0 });
    expect(await consume(user)).toMatchObject({ allowed: false, used: 90, capacity: 50 });
    await invariant(user);
  });
  it('deduplicates concurrent command delivery, including manual reset', async () => {
    const user = fresh();
    await consume(user);
    const id = randomUUID();
    const receipts = await Promise.all(
      Array.from({ length: 10 }, () => apply(user, { type: 'reset' }, id)),
    );
    expect(
      receipts.every((receipt) => JSON.stringify(receipt) === JSON.stringify(receipts[0])),
    ).toBe(true);
    const row = await invariant(user);
    expect(Number(row.quota_epoch)).toBe(1);
    expect(Number(row.event_version)).toBe(2);
    await expect(apply(user, { type: 'limit', value: 10 }, id)).rejects.toThrow(
      'Command ID conflict',
    );
    expect(await apply(user, { type: 'reset' })).toMatchObject({ revision: 2 });
  });
  it('replays receipts written with the former caller-assigned revision field', async () => {
    const user = fresh();
    const commandId = randomUUID();
    const legacy = { commandId, userId: user, revision: 1, action: { type: 'reset' } };
    const original = (await pool.query('SELECT apply_quota_command($1) AS receipt', [legacy]))
      .rows[0].receipt;
    expect(await apply(user, { type: 'reset' }, commandId)).toEqual(original);
    expect((await invariant(user)).quota_epoch).toBe('1');
  });
  it('serializes reset and expiry reclamation without refunding old epochs', async () => {
    const user = fresh();
    await seed(user, Array(100).fill(3600010));
    await Promise.all([
      apply(user, { type: 'reset' }),
      ...Array.from({ length: 10 }, () => pool.query('SELECT refresh_quota($1)', [user])),
    ]);
    expect((await invariant(user)).quota_balance).toBe(100);
    expect(await consume(user)).toMatchObject({ remaining: 99 });
  });
  it.each<AdminAction>([
    { type: 'limit', value: 50 },
    { type: 'extra-quota', value: 10 },
    { type: 'bypass', value: true },
    { type: 'reset' },
  ])('maintains accounting while requests race $type', async (action) => {
    const user = fresh();
    await seed(user, Array(90).fill(1000));
    await Promise.all([apply(user, action), ...Array.from({ length: 60 }, () => consume(user))]);
    await invariant(user);
  });
  it('refreshes idle quotas and emits a recovery event without charging', async () => {
    const user = fresh();
    await seed(user, Array(100).fill(3600010));
    const event = (await pool.query('SELECT refresh_quota($1) AS event', [user])).rows[0].event;
    expect(event).toMatchObject({
      kind: 'state',
      used: 0,
      remaining: 100,
      quotaCharged: false,
      nextChangeAt: null,
    });
  });
});

describe('two Nest API replicas sharing PostgreSQL', () => {
  const apps: INestApplication[] = [];
  const urls: string[] = [];
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const original = { ...process.env };
  const token = (subject: string) =>
    jwt.sign({ role: 'user' }, keys.privateKey, {
      algorithm: 'RS256',
      issuer: 'spikerz-demo',
      audience: 'spikerz',
      subject,
      expiresIn: '1h',
    });
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.AUTH_PUBLIC_KEY = keys.publicKey;
    for (let i = 0; i < 2; i++) {
      const module = await Test.createTestingModule({
        controllers: [DemoController],
        providers: [QuotaRepository, RateLimitInterceptor, TokenVerifier, UserGuard],
      }).compile();
      const app = module.createNestApplication();
      await app.get(TokenVerifier).initialize();
      await app.listen(0, '127.0.0.1');
      apps.push(app);
      urls.push(await app.getUrl());
    }
  });
  afterAll(async () => {
    for (const app of apps) await app.close();
    process.env = original;
  });
  it('admits exactly 100 of 200 requests across both replicas', async () => {
    const bearer = token(fresh());
    const responses = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        fetch(`${urls[i % 2]}/demo`, { headers: { authorization: `Bearer ${bearer}` } }),
      ),
    );
    expect(responses.filter((response) => response.status === 200)).toHaveLength(100);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(100);
    expect(
      responses
        .filter((response) => response.ok)
        .map((response) => Number(response.headers.get('x-count')))
        .sort((a, b) => a - b),
    ).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });
  it('authenticates before quota accounting, ignores spoofed identities, and shares route buckets', async () => {
    const before = (await pool.query('SELECT count(*) FROM user_state')).rows[0].count;
    expect((await fetch(`${urls[0]}/demo`, { headers: { 'x-user-id': 'spoof' } })).status).toBe(
      401,
    );
    expect((await pool.query('SELECT count(*) FROM user_state')).rows[0].count).toBe(before);
    const bearer = token(fresh());
    const headers = { authorization: `Bearer ${bearer}`, 'x-user-id': 'spoof' };
    expect((await fetch(`${urls[0]}/demo`, { headers })).headers.get('x-count')).toBe('99');
    expect((await fetch(`${urls[1]}/demo/second-route`, { headers })).headers.get('x-count')).toBe(
      '98',
    );
    const failure = await fetch(`${urls[1]}/demo/fail`, { headers });
    expect(failure.status).toBe(500);
    expect(failure.headers.get('x-count')).toBe('97');
  });
  it('returns 503 on an accounting failure, rolls back, and recovers for the next request', async () => {
    const subject = fresh();
    const id = JSON.stringify(['spikerz-demo', subject]);
    await pool.query('INSERT INTO user_state(user_id) VALUES($1)', [id]);
    // A conflicting event simulates a failure after decrement/log insertion.
    await pool.query(
      `INSERT INTO event_outbox(event_id,user_id,user_version,payload)
      VALUES(gen_random_uuid(),$1,1,'{}')`,
      [id],
    );
    const headers = { authorization: `Bearer ${token(subject)}` };
    const failed = await fetch(`${urls[0]}/demo`, { headers });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({
      message: 'Quota accounting unavailable. Request was not executed.',
    });
    expect((await invariant(id)).quota_balance).toBe(100);
    await pool.query('DELETE FROM event_outbox WHERE user_id=$1', [id]);
    expect((await fetch(`${urls[0]}/demo`, { headers })).headers.get('x-count')).toBe('99');
  });
  it('survives an idle database connection being terminated and reconnects', async () => {
    const repository = apps[0].get(QuotaRepository);
    const client = await repository.pool.connect();
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const disconnected = new Promise((resolve) => repository.pool.once('error', resolve));
    client.release();
    await pool.query('SELECT pg_terminate_backend($1)', [pid]);
    await disconnected;
    expect(
      (await fetch(`${urls[0]}/demo`, { headers: { authorization: `Bearer ${token(fresh())}` } }))
        .status,
    ).toBe(200);
  });
});
