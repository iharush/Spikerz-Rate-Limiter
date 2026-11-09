import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Module,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard, type AuthRequest, TokenVerifier } from '../../../packages/auth/src/index.js';
import { actionSchema, type AdminAction } from '../../../packages/contracts/src/index.js';
import { ControlRepository } from './repository.js';
import { ControlService } from './service.js';

@Controller('admin')
@UseGuards(AdminGuard)
class AdminController {
  constructor(
    private readonly repository: ControlRepository,
    private readonly service: ControlService,
  ) {}
  private submit(
    id: string,
    key: string,
    body: unknown,
    kind: AdminAction['type'],
    request: AuthRequest,
  ) {
    if (!id || id.length > 300 || !key || key.length > 200)
      throw new BadRequestException(
        'A user ID and Idempotency-Key (max 200 characters) are required',
      );
    const input = z
      .object({
        value: z.union([z.number(), z.boolean()]).optional(),
        enabled: z.boolean().optional(),
      })
      .strict()
      .safeParse(body);
    if (!input.success) throw new BadRequestException(input.error.flatten());
    const parsed = actionSchema.safeParse(
      kind === 'reset'
        ? { type: kind }
        : { type: kind, value: kind === 'bypass' ? input.data.enabled : input.data.value },
    );
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.service.execute(id, request.principal.userId, key, parsed.data);
  }
  @Put('users/:id/limit')
  @HttpCode(200)
  limit(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.submit(id, key, body, 'limit', request);
  }
  @Put('users/:id/extra-quota')
  @HttpCode(200)
  extra(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.submit(id, key, body, 'extra-quota', request);
  }
  @Put('users/:id/bypass')
  @HttpCode(200)
  bypass(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.submit(id, key, body, 'bypass', request);
  }
  @Post('users/:id/reset')
  @HttpCode(200)
  reset(
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
    @Req() request: AuthRequest,
  ) {
    return this.submit(id, key, body, 'reset', request);
  }
  @Get('commands/:id') command(@Param('id') id: string) {
    if (!z.uuid().safeParse(id).success) throw new BadRequestException('Invalid command ID');
    return this.repository.command(id);
  }
  @Get('users/:id/commands') commands(@Param('id') id: string) {
    return this.repository.commands(id);
  }
}
@Controller()
class HealthController {
  constructor(private readonly repository: ControlRepository) {}
  @Get('health') async health() {
    await this.repository.pool.query('SELECT 1');
    return { ok: true };
  }
}
@Module({
  controllers: [AdminController, HealthController],
  providers: [ControlRepository, ControlService, TokenVerifier, AdminGuard],
})
export class ControlModule {}
