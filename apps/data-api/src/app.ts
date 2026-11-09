import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  InternalServerErrorException,
  Module,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { z } from 'zod';
import { InternalGuard, TokenVerifier, UserGuard } from '../../../packages/auth/src/index.js';
import { actionSchema } from '../../../packages/contracts/src/index.js';
import { QuotaRepository } from './repository.js';
import { RateLimitInterceptor } from './interceptor.js';
import { DataWorker } from './worker.js';

@Controller('demo')
@UseGuards(UserGuard)
@UseInterceptors(RateLimitInterceptor)
export class DemoController {
  @Get() get() {
    return { message: 'Admitted by the rolling-hour limiter', at: new Date().toISOString() };
  }
  @Get('second-route') second() {
    return { message: 'This route shares the same user bucket' };
  }
  @Get('fail') fail(): never {
    throw new InternalServerErrorException('Demo business failure; admission remains charged');
  }
}
@Controller()
class DataController {
  constructor(private readonly repository: QuotaRepository) {}
  @Get('health') async health() {
    await this.repository.pool.query('SELECT 1');
    return { ok: true };
  }
  @Post('internal/commands')
  @UseGuards(InternalGuard)
  async apply(@Body() body: unknown) {
    const parsed = z
      .object({
        commandId: z.uuid(),
        userId: z.string().min(1).max(300),
        action: actionSchema,
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    try {
      return await this.repository.apply(parsed.data);
    } catch (error) {
      if ((error as { code?: string }).code === '23514')
        throw new ConflictException((error as Error).message);
      throw error;
    }
  }
}
@Module({
  controllers: [DemoController, DataController],
  providers: [
    QuotaRepository,
    RateLimitInterceptor,
    TokenVerifier,
    UserGuard,
    InternalGuard,
    DataWorker,
  ],
})
export class DataModule {}
