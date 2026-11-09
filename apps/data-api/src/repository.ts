import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import type { Command, RateEvent } from '../../../packages/contracts/src/index.js';

@Injectable()
export class QuotaRepository implements OnModuleDestroy {
  private readonly logger = new Logger(QuotaRepository.name);
  // Each plane owns its pool and schema; no service reads another plane's DB.
  readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 25,
    connectionTimeoutMillis: 3000,
    options: '-c statement_timeout=5000 -c lock_timeout=4000',
  });
  constructor() {
    // pg emits idle-connection failures outside query promises. Handle them so
    // a database restart doesn't crash the API before it can return a 503.
    this.pool.on('error', () => this.logger.error('Idle data database connection lost'));
  }
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(101)');
      await client.query(await readFile('infra/sql/data.sql', 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async consume(userId: string, requestId: string): Promise<RateEvent> {
    // Autocommit finishes before this resolves. Never retry an uncertain commit.
    const result = await this.pool.query('SELECT consume_quota($1, $2) AS decision', [
      userId,
      requestId,
    ]);
    return result.rows[0].decision;
  }
  async apply(command: Command): Promise<unknown> {
    const result = await this.pool.query('SELECT apply_quota_command($1::jsonb) AS result', [
      JSON.stringify(command),
    ]);
    return result.rows[0].result;
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
