import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { RateEvent } from '../../../packages/contracts/src/index.js';

export interface UserQuery {
  search?: string;
  status?: string;
  lastActiveSince?: string;
  cursor?: string;
  limit: number;
}
@Injectable()
export class ManagementRepository implements OnModuleDestroy {
  private readonly logger = new Logger(ManagementRepository.name);
  readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 15,
    connectionTimeoutMillis: 3000,
    options: '-c statement_timeout=5000 -c lock_timeout=4000',
  });
  constructor() {
    this.pool.on('error', () => this.logger.error('Idle management database connection lost'));
  }
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(301)');
      await client.query(await readFile('infra/sql/management.sql', 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async ingest(events: RateEvent[], health: unknown): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The singleton write serializes ingestion and feed commit order.
      await client.query('UPDATE feed_clock SET position = position WHERE id = true');
      for (const event of events) {
        const current = await client.query(
          'SELECT user_version FROM observed_users WHERE user_id = $1',
          [event.userId],
        );
        const version = Number(current.rows[0]?.user_version ?? 0);
        if (event.userVersion <= version) continue; // At-least-once delivery, including old retained-outbox replays.
        if (event.userVersion !== version + 1)
          throw new ConflictException(`Event gap for ${event.userId}: expected ${version + 1}`);
        await client.query(
          `INSERT INTO events(event_id,user_id,user_version,payload,occurred_at,kind,allowed,bypassed,quota_charged)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            event.eventId,
            event.userId,
            event.userVersion,
            event,
            event.asOf,
            event.kind,
            event.allowed,
            event.bypassed,
            event.quotaCharged,
          ],
        );
        await client.query(
          `INSERT INTO observed_users(user_id,user_version,state,last_request_at,as_of) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(user_id) DO UPDATE SET user_version=excluded.user_version, state=excluded.state,
          last_request_at=excluded.last_request_at, as_of=excluded.as_of`,
          [event.userId, event.userVersion, event, event.lastRequestAt, event.asOf],
        );
        const position = (
          await client.query('UPDATE feed_clock SET position = position + 1 RETURNING position')
        ).rows[0].position;
        await client.query('INSERT INTO browser_feed(position,event_id,payload) VALUES($1,$2,$3)', [
          position,
          event.eventId,
          // Full state/history already lives above; the feed only needs routing
          // information to notify browsers after this transaction commits.
          { userId: event.userId, kind: event.kind, allowed: event.allowed },
        ]);
      }
      await client.query(
        `INSERT INTO ingestion_health(id,received_at,source) VALUES(true,clock_timestamp(),$1)
        ON CONFLICT(id) DO UPDATE SET received_at=excluded.received_at,source=excluded.source`,
        [health],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async users(query: UserQuery) {
    const result = await this.pool.query(
      `SELECT state FROM observed_users WHERE
        ($1::text IS NULL OR strpos(lower(user_id), lower($1)) > 0) AND
        ($2::text IS NULL OR state->>'status' = $2) AND
        ($3::timestamptz IS NULL OR last_request_at >= $3) AND
        ($4::text IS NULL OR user_id > $4) ORDER BY user_id LIMIT $5`,
      [
        query.search ?? null,
        query.status ?? null,
        query.lastActiveSince ?? null,
        query.cursor ?? null,
        query.limit + 1,
      ],
    );
    const users = result.rows.slice(0, query.limit).map((row) => row.state);
    return {
      users,
      nextCursor: result.rows.length > query.limit ? users.at(-1).userId : null,
      asOf: new Date().toISOString(),
    };
  }
  async user(id: string) {
    const result = await this.pool.query('SELECT state FROM observed_users WHERE user_id=$1', [id]);
    if (!result.rowCount) throw new NotFoundException('User has not been observed');
    return result.rows[0].state;
  }
  async history(userId: string, range: 'hour' | 'day', cursor?: string) {
    const result = await this.pool.query(
      `SELECT payload, occurred_at, event_id FROM events
      WHERE user_id=$1 AND kind='decision' AND occurred_at > clock_timestamp() - $2::interval
      AND ($3::jsonb IS NULL OR (occurred_at,event_id) < (($3::jsonb->>0)::timestamptz,($3::jsonb->>1)::uuid))
      ORDER BY occurred_at DESC,event_id DESC LIMIT 101`,
      [userId, range === 'day' ? '24 hours' : '1 hour', cursor ?? null],
    );
    const last = result.rows[99];
    const buckets = await this.pool.query(
      `SELECT date_trunc($3,occurred_at) AS at,
      count(*) FILTER(WHERE allowed AND NOT bypassed)::integer AS regular,
      count(*) FILTER(WHERE bypassed)::integer AS bypassed,
      count(*) FILTER(WHERE allowed=false)::integer AS denied
      FROM events WHERE user_id=$1 AND kind='decision' AND occurred_at > clock_timestamp() - $2::interval
      GROUP BY 1 ORDER BY 1`,
      [userId, range === 'day' ? '24 hours' : '1 hour', range === 'day' ? 'hour' : 'minute'],
    );
    return {
      requests: result.rows.slice(0, 100).map((row) => row.payload),
      buckets: buckets.rows,
      nextCursor:
        result.rows.length > 100
          ? JSON.stringify([last.occurred_at.toISOString(), last.event_id])
          : null,
    };
  }
  async summary() {
    const users = await this.pool.query(`SELECT count(*)::integer AS total,
      count(*) FILTER(WHERE state->>'status'='Warning')::integer AS near FROM observed_users WHERE last_request_at IS NOT NULL`);
    const denied = await this.pool
      .query(`SELECT count(*)::integer AS count FROM events WHERE kind='decision'
      AND allowed=false AND occurred_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
    return {
      totalUsers: users.rows[0].total,
      nearLimitPercent: users.rows[0].total ? (100 * users.rows[0].near) / users.rows[0].total : 0,
      deniedToday: denied.rows[0].count,
      asOf: new Date().toISOString(),
    };
  }
  async topUsers() {
    const result = await this.pool
      .query(`SELECT e.user_id AS "userId", count(*)::integer AS admitted,
      count(*) FILTER(WHERE e.bypassed)::integer AS bypassed,
      (u.state->>'used')::integer AS "chargedUsage" FROM events e JOIN observed_users u ON u.user_id=e.user_id
      WHERE e.kind='decision' AND e.allowed=true AND e.occurred_at > clock_timestamp() - interval '1 hour'
      GROUP BY e.user_id,u.state ORDER BY admitted DESC,e.user_id LIMIT 10`);
    return result.rows;
  }
  async health() {
    const result = await this.pool.query('SELECT received_at,source FROM ingestion_health');
    const health = result.rows[0];
    return {
      asOf: new Date().toISOString(),
      lastIngestionAt: health?.received_at ?? null,
      stale: !health || Date.now() - health.received_at.getTime() > 5000,
      ...(health?.source ?? { outboxBacklog: null, expiryWorkerAt: null }),
    };
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
