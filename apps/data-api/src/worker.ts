import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { QuotaRepository } from './repository.js';

@Injectable()
export class DataWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DataWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private lastRefreshAt: string | null = null;
  constructor(private readonly repository: QuotaRepository) {}
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), 250);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const client = await this.repository.pool.connect().catch(() => null);
    if (!client) {
      this.busy = false;
      return;
    }
    let locked = false;
    try {
      // One dispatcher across replicas. Session lock is on this leased client;
      // admission transactions never wait on outbound HTTP or management.
      locked = (await client.query('SELECT pg_try_advisory_lock(102) AS locked')).rows[0].locked;
      if (!locked) return;
      const due = await client.query(
        'SELECT user_id FROM user_state WHERE next_change_at <= clock_timestamp() ORDER BY next_change_at LIMIT 100',
      );
      for (const row of due.rows) await client.query('SELECT refresh_quota($1)', [row.user_id]);
      this.lastRefreshAt = new Date().toISOString();
      const pending =
        await client.query(`SELECT event_id, payload FROM event_outbox WHERE delivered_at IS NULL
        ORDER BY created_at, user_id, user_version LIMIT 200`);
      const backlog = await client.query(
        'SELECT count(*)::integer AS count, min(created_at) AS oldest FROM event_outbox WHERE delivered_at IS NULL',
      );
      const response = await fetch(`${process.env.MANAGEMENT_INTERNAL_URL}/internal/events`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
        headers: {
          'content-type': 'application/json',
          'x-service-key': process.env.INTERNAL_SERVICE_KEY!,
        },
        body: JSON.stringify({
          events: pending.rows.map((row) => row.payload),
          health: {
            outboxBacklog: backlog.rows[0].count,
            oldestPendingAt: backlog.rows[0].oldest,
            expiryWorkerAt: this.lastRefreshAt,
          },
        }),
      });
      if (!response.ok) throw new Error(`Management delivery returned ${response.status}`);
      if (pending.rowCount)
        await client.query(
          'UPDATE event_outbox SET delivered_at = clock_timestamp() WHERE event_id = ANY($1::uuid[])',
          [pending.rows.map((row) => row.event_id)],
        );
      // Only acknowledged events and old-epoch charges are safe to discard here.
      await client.query(
        "DELETE FROM event_outbox WHERE delivered_at < clock_timestamp() - interval '1 day'",
      );
      await client.query(
        'DELETE FROM quota_log q USING user_state s WHERE q.user_id = s.user_id AND q.quota_epoch < s.quota_epoch',
      );
    } catch (error) {
      this.logger.warn(`Delivery/refresh deferred: ${(error as Error).message}`);
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(102)').catch(() => {});
      client.release();
      this.busy = false;
    }
  }
}
