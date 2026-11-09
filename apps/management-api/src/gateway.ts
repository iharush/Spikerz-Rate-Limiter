import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { TokenVerifier } from '../../../packages/auth/src/index.js';
import { ManagementRepository } from './repository.js';

@WebSocketGateway({
  transports: ['websocket'],
  cors: { origin: process.env.WEB_ORIGIN ?? 'http://localhost:8080' },
})
export class RateGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly expirations = new Map<string, NodeJS.Timeout>();
  constructor(private readonly verifier: TokenVerifier) {}
  handleConnection(socket: Socket): void {
    try {
      const principal = this.verifier.authenticate(socket.handshake.auth.token);
      if (principal.role !== 'admin') throw new Error('Admin required');
      socket.data.principal = principal;
      this.expirations.set(
        socket.id,
        setTimeout(
          () => socket.disconnect(true),
          Math.min(principal.expiresAt - Date.now(), 2_147_483_647),
        ),
      );
    } catch {
      socket.disconnect(true);
    }
  }
  handleDisconnect(socket: Socket): void {
    clearTimeout(this.expirations.get(socket.id));
    this.expirations.delete(socket.id);
  }
  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket) {
    if (!socket.data.principal || socket.data.principal.expiresAt <= Date.now()) {
      socket.disconnect(true);
      return;
    }
    // Subscribe before acknowledging. The browser then fetches current HTTP
    // data, and any later change notification schedules another refresh.
    await socket.join('admins');
    return { subscribed: true };
  }
}

@Injectable()
export class FeedWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FeedWorker.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private position = '0';
  private lastHeartbeat = 0;
  private lastCleanup = 0;
  constructor(
    private readonly repository: ManagementRepository,
    private readonly gateway: RateGateway,
  ) {}
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), 100);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
  async tick(): Promise<void> {
    if (this.busy || !this.gateway.server) return;
    this.busy = true;
    try {
      const rows = await this.repository.pool.query(
        'SELECT position,payload FROM browser_feed WHERE position > $1 ORDER BY position LIMIT 500',
        [this.position],
      );
      for (const row of rows.rows) {
        const event = row.payload;
        this.gateway.server.to('admins').emit(
          event.kind === 'decision' && event.allowed === false
            ? 'rate:limit_exceeded'
            : 'rate:update',
          // HTTP is the source of dashboard data; this only invalidates it.
          { userId: event.userId },
        );
        this.position = row.position;
      }
      if (Date.now() - this.lastHeartbeat > 1000) {
        this.gateway.server.to('admins').emit('rate:heartbeat', await this.repository.health());
        this.lastHeartbeat = Date.now();
      }
      if (Date.now() - this.lastCleanup > 60000) {
        await this.repository.pool.query(
          "DELETE FROM events WHERE occurred_at < clock_timestamp() - interval '26 hours'",
        );
        await this.repository.pool.query(
          "DELETE FROM browser_feed WHERE created_at < clock_timestamp() - interval '26 hours'",
        );
        this.lastCleanup = Date.now();
      }
    } catch (error) {
      this.logger.warn(`Feed deferred: ${(error as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
