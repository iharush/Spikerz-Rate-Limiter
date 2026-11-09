import 'reflect-metadata';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { json } from 'express';
import jwt from 'jsonwebtoken';
import { io, type Socket } from 'socket.io-client';
import { DataModule } from '../../apps/data-api/src/app.js';
import { QuotaRepository } from '../../apps/data-api/src/repository.js';
import { DataWorker } from '../../apps/data-api/src/worker.js';
import { ControlModule } from '../../apps/control-api/src/app.js';
import { ControlRepository } from '../../apps/control-api/src/repository.js';
import { ControlService } from '../../apps/control-api/src/service.js';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { ManagementModule } from '../../apps/management-api/src/app.js';
import { ManagementRepository } from '../../apps/management-api/src/repository.js';
import { FeedWorker, RateGateway } from '../../apps/management-api/src/gateway.js';
import { TokenVerifier } from '../../packages/auth/src/index.js';
import type { RateChange } from '../../packages/contracts/src/index.js';

describe('synchronous control, management and WebSocket integration', () => {
  const apps: INestApplication[] = [];
  const original = { ...process.env };
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const sign = (subject: string, role = 'admin', expiresIn = 3600) =>
    jwt.sign({ role }, keys.privateKey, {
      algorithm: 'RS256',
      issuer: 'spikerz-demo',
      audience: 'spikerz',
      subject,
      expiresIn,
    });
  const admin = sign('admin');
  const user = sign('alice', 'user');
  const uid = '["spikerz-demo","alice"]';
  let data: QuotaRepository;
  let control: ControlRepository;
  let management: ManagementRepository;
  let dataUrl: string;
  let controlUrl: string;
  let managementUrl: string;
  let dataWorker: DataWorker;
  let service: ControlService;
  let feedWorker: FeedWorker;
  const sockets: Socket[] = [];
  const request = (
    url: string,
    path: string,
    method = 'GET',
    body?: unknown,
    token = admin,
    key?: string,
  ) =>
    fetch(url + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function connect(token = admin): Promise<Socket> {
    const socket = io(managementUrl, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
    return socket;
  }
  const subscribe = (socket: Socket) =>
    new Promise<{ subscribed: boolean }>((resolve) => socket.emit('subscribe', resolve));
  beforeAll(async () => {
    process.env.AUTH_PUBLIC_KEY = keys.publicKey;
    process.env.INTERNAL_SERVICE_KEY = 'test-only-service-key-with-at-least-32-characters';
    for (const [module, worker, repository, url] of [
      [
        DataModule,
        DataWorker,
        QuotaRepository,
        process.env.TEST_DATA_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55431/spikerz_test',
      ],
      [
        ControlModule,
        null,
        ControlRepository,
        process.env.TEST_CONTROL_DATABASE_URL ??
          'postgres://test:test@127.0.0.1:55432/spikerz_test',
      ],
      [
        ManagementModule,
        FeedWorker,
        ManagementRepository,
        process.env.TEST_MANAGEMENT_DATABASE_URL ??
          'postgres://test:test@127.0.0.1:55433/spikerz_test',
      ],
    ] as const) {
      if (!new URL(url).pathname.endsWith('_test'))
        throw new Error('Isolated test database required');
      process.env.DATABASE_URL = url;
      const builder = Test.createTestingModule({ imports: [module] });
      if (worker) builder.overrideProvider(worker).useValue({});
      const testing = await builder.compile();
      const app = testing.createNestApplication({ bodyParser: false });
      app.use(json({ limit: '1mb' }));
      await app.get(repository).initialize();
      await app.get(TokenVerifier).initialize();
      await app.listen(0, '127.0.0.1');
      apps.push(app);
    }
    [dataUrl, controlUrl, managementUrl] = await Promise.all(apps.map((app) => app.getUrl()));
    data = apps[0].get(QuotaRepository);
    control = apps[1].get(ControlRepository);
    management = apps[2].get(ManagementRepository);
    process.env.DATA_INTERNAL_URL = dataUrl;
    process.env.MANAGEMENT_INTERNAL_URL = managementUrl;
    dataWorker = new DataWorker(data);
    service = apps[1].get(ControlService);
    feedWorker = new FeedWorker(management, apps[2].get(RateGateway));
  });
  beforeEach(async () => {
    await data.pool.query('TRUNCATE user_state,quota_log,applied_commands,event_outbox CASCADE');
    await control.pool.query('TRUNCATE commands');
    await management.pool.query('TRUNCATE observed_users,events,browser_feed,ingestion_health');
    await management.pool.query('UPDATE feed_clock SET position=0');
    feedWorker = new FeedWorker(management, apps[2].get(RateGateway));
  });
  afterEach(() => {
    for (const socket of sockets) socket.disconnect();
    sockets.length = 0;
  });
  afterAll(async () => {
    for (const app of apps) await app.close();
    process.env = original;
  });

  it('returns success only after the data plane applies the change, and deduplicates keys', async () => {
    const path = `/admin/users/${encodeURIComponent(uid)}/limit`;
    const key = randomUUID();
    expect((await request(controlUrl, path, 'PUT', { value: 2 }, user, key)).status).toBe(403);
    expect((await request(controlUrl, path, 'PUT', { value: 2 })).status).toBe(400);
    expect((await request(controlUrl, path, 'PUT', { value: 0 }, admin, key)).status).toBe(400);
    const response = await request(controlUrl, path, 'PUT', { value: 2 }, admin, key);
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({
      revision: 1,
      state: { baseLimit: 2, remaining: 2, policyRevision: 1 },
    });
    // No worker tick or wait: the next admission already sees the new policy.
    expect(await data.consume(uid, randomUUID())).toMatchObject({
      baseLimit: 2,
      remaining: 1,
      policyRevision: 1,
    });
    const replay = await (await request(controlUrl, path, 'PUT', { value: 2 }, admin, key)).json();
    expect(replay).toEqual(receipt);
    expect((await request(controlUrl, path, 'PUT', { value: 3 }, admin, key)).status).toBe(409);
    const audit = await (await request(controlUrl, `/admin/commands/${receipt.commandId}`)).json();
    expect(audit.status).toBe('applied');
    expect(await control.commands(uid)).toHaveLength(1);
    expect(
      (await request(controlUrl, `/admin/users/${encodeURIComponent(uid)}/policy`)).status,
    ).toBe(404);
    expect(
      (await control.pool.query("SELECT to_regclass('desired_policies') AS table_name")).rows[0]
        .table_name,
    ).toBeNull();
  });
  it('fails synchronously during a data outage and only retries on another explicit request', async () => {
    const path = `/admin/users/${encodeURIComponent(uid)}/limit`;
    const key = randomUUID();
    process.env.DATA_INTERNAL_URL = 'http://127.0.0.1:1';
    try {
      const response = await request(controlUrl, path, 'PUT', { value: 3 }, admin, key);
      expect(response.status).toBe(503);
      expect((await response.json()).message).toContain('same Idempotency-Key');
    } finally {
      process.env.DATA_INTERNAL_URL = dataUrl;
    }
    expect((await control.commands(uid))[0].status).toBe('unconfirmed');
    expect(await data.consume(uid, randomUUID())).toMatchObject({
      baseLimit: 100,
      policyRevision: 0,
    });
    const retried = await request(controlUrl, path, 'PUT', { value: 3 }, admin, key);
    expect(retried.status).toBe(200);
    expect(await data.consume(uid, randomUUID())).toMatchObject({
      baseLimit: 3,
      policyRevision: 1,
    });
    expect(await control.commands(uid)).toHaveLength(1);
  });
  it('replays a lost acknowledgment without applying reset twice', async () => {
    const record = await control.reserve(uid, 'admin', randomUUID(), { type: 'reset' });
    const receipt = await data.apply({
      commandId: record.command_id,
      userId: uid,
      action: { type: 'reset' },
    });
    // Data committed but the control plane did not receive/save its receipt.
    const retry = await service.execute(
      uid,
      'admin',
      (
        await control.pool.query('SELECT idempotency_key FROM commands WHERE command_id=$1', [
          record.command_id,
        ])
      ).rows[0].idempotency_key,
      { type: 'reset' },
    );
    expect(retry).toEqual(receipt);
    const row = (
      await data.pool.query('SELECT quota_epoch,event_version FROM user_state WHERE user_id=$1', [
        uid,
      ])
    ).rows[0];
    expect(Number(row.quota_epoch)).toBe(1);
    expect(Number(row.event_version)).toBe(1);
  });
  it('deduplicates concurrent HTTP retries and assigns revisions to distinct concurrent changes', async () => {
    const path = `/admin/users/${encodeURIComponent(uid)}/reset`;
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(controlUrl, path, 'POST', {}, admin, key)),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const receipts = await Promise.all(responses.map((response) => response.json()));
    expect(new Set(receipts.map((receipt) => receipt.commandId)).size).toBe(1);
    const edits = await Promise.all([
      service.execute(uid, 'admin', randomUUID(), { type: 'limit', value: 20 }),
      service.execute(uid, 'admin', randomUUID(), { type: 'extra-quota', value: 5 }),
    ]);
    expect(edits.map((receipt) => receipt.revision).sort()).toEqual([2, 3]);
    expect(await data.consume(uid, randomUUID())).toMatchObject({
      baseLimit: 20,
      extraQuota: 5,
      policyRevision: 3,
    });
    expect(
      (await data.pool.query('SELECT quota_epoch FROM user_state WHERE user_id=$1', [uid])).rows[0]
        .quota_epoch,
    ).toBe('1');
  });
  it('retains a committed reset after a lost HTTP response and applies it once on retry', async () => {
    let calls = 0;
    const proxy = createServer(async (req, res) => {
      calls++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await fetch(`${dataUrl}/internal/commands`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-key': process.env.INTERNAL_SERVICE_KEY!,
        },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const body = await response.text();
      if (calls === 1) res.destroy();
      else {
        res.writeHead(response.status, { 'content-type': 'application/json' });
        res.end(body);
      }
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address() as { port: number };
    const key = randomUUID();
    process.env.DATA_INTERNAL_URL = `http://127.0.0.1:${address.port}`;
    try {
      const path = `/admin/users/${encodeURIComponent(uid)}/reset`;
      expect((await request(controlUrl, path, 'POST', {}, admin, key)).status).toBe(503);
      expect((await control.commands(uid))[0].status).toBe('unconfirmed');
      expect((await request(controlUrl, path, 'POST', {}, admin, key)).status).toBe(200);
      expect(calls).toBe(2);
      expect(
        (await data.pool.query('SELECT quota_epoch FROM user_state WHERE user_id=$1', [uid]))
          .rows[0].quota_epoch,
      ).toBe('1');
    } finally {
      process.env.DATA_INTERNAL_URL = dataUrl;
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it('migrates the old control schema while preserving audit records and disabling queued delivery', async () => {
    const client = await control.pool.connect();
    const schema = `legacy_${randomUUID().replaceAll('-', '')}`;
    const appliedId = randomUUID();
    const queuedId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path TO ${schema}`);
      await client.query(`CREATE TABLE desired_policies(user_id text PRIMARY KEY);
        CREATE TABLE commands(command_id uuid PRIMARY KEY,idempotency_key text UNIQUE NOT NULL,
          fingerprint text NOT NULL,user_id text NOT NULL REFERENCES desired_policies,
          revision bigint NOT NULL,action jsonb NOT NULL,actor_id text NOT NULL,
          status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','failed')),
          attempts integer DEFAULT 0,next_attempt_at timestamptz DEFAULT clock_timestamp(),
          created_at timestamptz DEFAULT clock_timestamp(),applied_at timestamptz,last_error text,result jsonb,
          UNIQUE(user_id,revision));
        CREATE INDEX command_dispatch ON commands(status,next_attempt_at);`);
      await client.query('INSERT INTO desired_policies VALUES($1)', [uid]);
      await client.query(
        `INSERT INTO commands(command_id,idempotency_key,fingerprint,user_id,revision,action,actor_id,status,result)
        VALUES($1,'old-applied','old-hash',$3,1,'{"type":"reset"}','admin','applied','{"kept":true}'),
              ($2,'old-queued','old-hash',$3,2,'{"type":"limit","value":10}','admin','pending',NULL)`,
        [appliedId, queuedId, uid],
      );
      const migration = await readFile('infra/sql/control.sql', 'utf8');
      await client.query(migration);
      await client.query(migration);
      expect(
        (await client.query("SELECT to_regclass('desired_policies') AS table_name")).rows[0]
          .table_name,
      ).toBeNull();
      const records = (await client.query('SELECT * FROM commands ORDER BY created_at,command_id'))
        .rows;
      expect(records).toHaveLength(2);
      expect(records.find((record) => record.command_id === appliedId)).toMatchObject({
        status: 'applied',
        revision: '1',
        result: { kept: true },
      });
      expect(records.find((record) => record.command_id === queuedId)).toMatchObject({
        status: 'unconfirmed',
        revision: null,
      });
      const columns = (
        await client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='commands'",
          [schema],
        )
      ).rows.map((row) => row.column_name);
      for (const removed of ['fingerprint', 'attempts', 'next_attempt_at'])
        expect(columns).not.toContain(removed);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('buffers events through a management outage, then deduplicates analytics after redelivery', async () => {
    await data.consume(uid, randomUUID());
    await data.consume(uid, randomUUID());
    process.env.MANAGEMENT_INTERNAL_URL = 'http://127.0.0.1:1';
    await dataWorker.tick();
    process.env.MANAGEMENT_INTERNAL_URL = managementUrl;
    expect(
      (
        await data.pool.query(
          'SELECT count(*)::integer AS n FROM event_outbox WHERE delivered_at IS NULL',
        )
      ).rows[0].n,
    ).toBe(2);
    expect(await data.consume(uid, randomUUID())).toMatchObject({ remaining: 97 });
    await dataWorker.tick();
    expect(await management.summary()).toMatchObject({ totalUsers: 1, deniedToday: 0 });
    await data.pool.query('UPDATE event_outbox SET delivered_at=NULL');
    await dataWorker.tick();
    expect((await management.topUsers())[0]).toMatchObject({
      admitted: 3,
      bypassed: 0,
      chargedUsage: 3,
    });
    expect((await management.history(uid, 'hour')).requests).toHaveLength(3);
  });
  it('rejects event gaps atomically and accepts ordered replay', async () => {
    const events = await Promise.all([
      data.consume(uid, randomUUID()),
      data.consume(uid, randomUUID()),
    ]);
    events.sort((a, b) => a.userVersion - b.userVersion);
    await expect(management.ingest([events[1]], {})).rejects.toThrow('Event gap');
    expect((await management.summary()).totalUsers).toBe(0);
    await management.ingest(events, {});
    await management.ingest(events, {});
    expect((await management.history(uid, 'hour')).requests).toHaveLength(2);
    expect(
      (await management.pool.query('SELECT count(*)::integer AS n FROM browser_feed')).rows[0].n,
    ).toBe(2);
  });
  it('keeps UTC denials and bypassed activity separate from charged quota', async () => {
    await service.execute(uid, 'admin', randomUUID(), { type: 'limit', value: 1 });
    await data.consume(uid, randomUUID());
    await data.consume(uid, randomUUID());
    await service.execute(uid, 'admin', randomUUID(), { type: 'bypass', value: true });
    await data.consume(uid, randomUUID());
    await dataWorker.tick();
    expect(await management.summary()).toMatchObject({
      totalUsers: 1,
      deniedToday: 1,
      nearLimitPercent: 0,
    });
    expect((await management.topUsers())[0]).toMatchObject({
      admitted: 2,
      bypassed: 1,
      chargedUsage: 1,
    });
    const history = await management.history(uid, 'hour');
    expect(history.buckets[0]).toMatchObject({ regular: 1, bypassed: 1, denied: 1 });
    expect((await management.users({ status: 'Exceeded', limit: 100 })).users).toHaveLength(1);
    expect((await management.users({ search: 'does-not-exist', limit: 100 })).users).toHaveLength(
      0,
    );
  });
  it('does not count an unobserved admin target as an authenticated observed user', async () => {
    await service.execute(uid, 'admin', randomUUID(), { type: 'limit', value: 1 });
    await dataWorker.tick();
    expect((await management.summary()).totalUsers).toBe(0);
  });
  it('authenticates internal APIs and query endpoints', async () => {
    expect((await request(managementUrl, '/users', 'GET', undefined, user)).status).toBe(403);
    expect(
      (await request(managementUrl, '/internal/events', 'POST', { events: [], health: {} })).status,
    ).toBe(401);
    expect((await request(dataUrl, '/internal/commands', 'POST', {})).status).toBe(401);
  });
  it('broadcasts only a user ID and lets HTTP return current state and history', async () => {
    const socket = await connect();
    expect(await subscribe(socket)).toEqual({ subscribed: true });
    const received: RateChange[] = [];
    const exceeded: RateChange[] = [];
    socket.on('rate:update', (update) => received.push(update));
    socket.on('rate:limit_exceeded', (update) => exceeded.push(update));
    await service.execute(uid, 'admin', randomUUID(), { type: 'limit', value: 1 });
    await data.consume(uid, randomUUID());
    await data.consume(uid, randomUUID());
    await dataWorker.tick();
    await feedWorker.tick();
    // An acknowledgment acts as a transport barrier after previous broadcasts.
    await subscribe(socket);
    expect(received).toEqual([{ userId: uid }, { userId: uid }]);
    expect(exceeded).toEqual([{ userId: uid }]);
    expect(
      await (await request(managementUrl, `/users/${encodeURIComponent(uid)}`)).json(),
    ).toMatchObject({ used: 1, remaining: 0, baseLimit: 1 });
    const history = await (
      await request(managementUrl, `/users/${encodeURIComponent(uid)}/requests`)
    ).json();
    expect(history.requests).toHaveLength(2);
    expect(history.requests.map((event: { allowed: boolean }) => event.allowed).sort()).toEqual([
      false,
      true,
    ]);
    // Duplicate outbox delivery must not create another notification.
    await data.pool.query('UPDATE event_outbox SET delivered_at=NULL');
    await dataWorker.tick();
    await feedWorker.tick();
    await subscribe(socket);
    expect(received).toHaveLength(2);
    expect(exceeded).toHaveLength(1);
  });
  it('recovers missed changes through HTTP on reconnect without a replay cursor', async () => {
    await data.consume(uid, randomUUID());
    await dataWorker.tick();
    const socket = await connect();
    await subscribe(socket);
    const initial = await (await request(managementUrl, '/users')).json();
    expect(initial.users[0]).toMatchObject({ used: 1, remaining: 99 });
    expect(initial).not.toHaveProperty('position');
    socket.disconnect();
    await service.execute(uid, 'admin', randomUUID(), { type: 'reset' });
    await dataWorker.tick();
    await feedWorker.tick();
    // Recovery does not depend on retaining or replaying old notifications.
    await management.pool.query('DELETE FROM browser_feed');
    const reconnect = await connect();
    expect(await subscribe(reconnect)).toEqual({ subscribed: true });
    const refreshed = await (await request(managementUrl, '/users')).json();
    expect(refreshed.users[0]).toMatchObject({ used: 0, remaining: 100, policyRevision: 1 });
    expect((await management.history(uid, 'hour')).requests).toHaveLength(1);
  });
  it('notifies changes committed before a feed worker restart', async () => {
    const socket = await connect();
    await subscribe(socket);
    const received: RateChange[] = [];
    socket.on('rate:update', (change) => received.push(change));
    await data.consume(uid, randomUUID());
    await dataWorker.tick();
    const restarted = new FeedWorker(management, apps[2].get(RateGateway));
    await restarted.tick();
    await subscribe(socket);
    expect(received).toEqual([{ userId: uid }]);
    expect(await management.user(uid)).toMatchObject({ used: 1, remaining: 99 });
  });
  it('rejects a non-admin socket and disconnects an admin when its token expires', async () => {
    const unauthorized = await connect(user);
    await new Promise<void>((resolve) => {
      if (!unauthorized.connected) return resolve();
      unauthorized.once('disconnect', () => resolve());
    });
    expect(unauthorized.connected).toBe(false);
    const expiring = await connect(sign('short-admin', 'admin', 1));
    await subscribe(expiring);
    await new Promise<void>((resolve) => expiring.once('disconnect', () => resolve()));
    expect(expiring.connected).toBe(false);
  });
  it('sends source health heartbeats even without quota changes', async () => {
    const socket = await connect();
    await subscribe(socket);
    const heartbeat = new Promise<unknown>((resolve) => socket.once('rate:heartbeat', resolve));
    await dataWorker.tick();
    await feedWorker.tick();
    expect(await heartbeat).toMatchObject({
      stale: false,
      outboxBacklog: 0,
      oldestPendingAt: null,
    });
  });
});
