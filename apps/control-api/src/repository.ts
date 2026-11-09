import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import type { AdminAction, CommandReceipt } from '../../../packages/contracts/src/index.js';

export interface CommandRecord {
  command_id: string;
  user_id: string;
  revision: string | null;
  action: AdminAction;
  status: 'unconfirmed' | 'applied' | 'failed';
  result: CommandReceipt | null;
  last_error: string | null;
}

@Injectable()
export class ControlRepository implements OnModuleDestroy {
  private readonly logger = new Logger(ControlRepository.name);
  readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
    options: '-c statement_timeout=5000 -c lock_timeout=4000',
  });
  constructor() {
    this.pool.on('error', () => this.logger.error('Idle control database connection lost'));
  }
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(201)');
      await client.query(await readFile('infra/sql/control.sql', 'utf8'));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async reserve(
    userId: string,
    actor: string,
    key: string,
    action: AdminAction,
  ): Promise<CommandRecord> {
    // The unique key gives simultaneous HTTP retries the same command ID.
    // This is an audit/idempotency record, not a queue: nothing scans or sends it.
    await this.pool.query(
      `INSERT INTO commands(command_id,idempotency_key,user_id,action,actor_id)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(idempotency_key) DO NOTHING`,
      [randomUUID(), key, userId, action, actor],
    );
    const result = await this.pool.query<CommandRecord & { matches: boolean }>(
      `SELECT *,
      (user_id=$2 AND actor_id=$3 AND action=$4::jsonb) AS matches
      FROM commands WHERE idempotency_key=$1`,
      [key, userId, actor, action],
    );
    const { matches, ...record } = result.rows[0];
    if (!matches)
      throw new ConflictException('Idempotency key was already used with another request');
    return record;
  }
  async applied(id: string, receipt: CommandReceipt): Promise<void> {
    await this.pool.query(
      `UPDATE commands SET status='applied',revision=$2,result=$3,
      applied_at=clock_timestamp(),last_error=NULL WHERE command_id=$1`,
      [id, receipt.revision, receipt],
    );
  }
  async unsuccessful(id: string, status: 'unconfirmed' | 'failed', message: string): Promise<void> {
    // A late failed duplicate must not overwrite another request's confirmed success.
    await this.pool.query(
      `UPDATE commands SET status=$2,last_error=$3
      WHERE command_id=$1 AND status<>'applied'`,
      [id, status, message],
    );
  }
  async command(id: string): Promise<CommandRecord> {
    const result = await this.pool.query<CommandRecord>(
      'SELECT * FROM commands WHERE command_id=$1',
      [id],
    );
    if (!result.rowCount) throw new NotFoundException('Command not found');
    return result.rows[0];
  }
  async commands(userId: string): Promise<CommandRecord[]> {
    return (
      await this.pool.query<CommandRecord>(
        `SELECT * FROM commands
      WHERE user_id=$1 ORDER BY created_at DESC,command_id DESC LIMIT 20`,
        [userId],
      )
    ).rows;
  }
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
