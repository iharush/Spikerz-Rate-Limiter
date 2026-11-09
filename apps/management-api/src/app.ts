import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, InternalGuard, TokenVerifier } from '../../../packages/auth/src/index.js';
import { eventSchema } from '../../../packages/contracts/src/index.js';
import { ManagementRepository } from './repository.js';
import { FeedWorker, RateGateway } from './gateway.js';

@Controller()
@UseGuards(AdminGuard)
class QueryController {
  constructor(private readonly repository: ManagementRepository) {}
  @Get('users') users(@Query() query: Record<string, string>) {
    const parsed = z
      .object({
        search: z.string().max(300).optional(),
        status: z.enum(['OK', 'Warning', 'Exceeded']).optional(),
        lastActiveSince: z.iso.datetime({ offset: true }).optional(),
        cursor: z.string().max(300).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .strict()
      .safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.repository.users(parsed.data);
  }
  @Get('users/:id') user(@Param('id') id: string) {
    return this.repository.user(id);
  }
  @Get('users/:id/requests') history(
    @Param('id') id: string,
    @Query('range') range = 'hour',
    @Query('cursor') cursor?: string,
  ) {
    if (!['hour', 'day'].includes(range))
      throw new BadRequestException('range must be hour or day');
    if (cursor) {
      try {
        z.tuple([z.iso.datetime({ offset: true }), z.uuid()]).parse(JSON.parse(cursor));
      } catch {
        throw new BadRequestException('Invalid history cursor');
      }
    }
    return this.repository.history(id, range as 'hour' | 'day', cursor);
  }
  @Get('analytics/summary') summary() {
    return this.repository.summary();
  }
  @Get('analytics/top-users') top() {
    return this.repository.topUsers();
  }
  @Get('status') status() {
    return this.repository.health();
  }
}
@Controller()
class InternalController {
  constructor(private readonly repository: ManagementRepository) {}
  @Get('health') async health() {
    await this.repository.pool.query('SELECT 1');
    return { ok: true };
  }
  @Post('internal/events')
  @HttpCode(200)
  @UseGuards(InternalGuard)
  async ingest(@Body() body: unknown) {
    const parsed = z
      .object({
        events: z.array(eventSchema).max(500),
        health: z
          .object({
            outboxBacklog: z.number().int().nonnegative(),
            oldestPendingAt: z.iso.datetime({ offset: true }).nullable(),
            expiryWorkerAt: z.iso.datetime({ offset: true }),
          })
          .strict(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    await this.repository.ingest(parsed.data.events, parsed.data.health);
    return { ok: true };
  }
}
@Module({
  controllers: [QueryController, InternalController],
  providers: [
    ManagementRepository,
    TokenVerifier,
    AdminGuard,
    InternalGuard,
    RateGateway,
    FeedWorker,
  ],
})
export class ManagementModule {}
