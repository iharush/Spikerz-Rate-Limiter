import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import type { AuthRequest } from '../../../packages/auth/src/index.js';
import type { RateEvent } from '../../../packages/contracts/src/index.js';
import { QuotaRepository } from './repository.js';

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RateLimitInterceptor.name);
  constructor(private readonly repository: QuotaRepository) {}
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    let decision: RateEvent;
    try {
      decision = await this.repository.consume(request.principal.userId, randomUUID());
    } catch {
      this.logger.error('Quota storage unavailable or admission outcome uncertain');
      throw new ServiceUnavailableException(
        'Quota accounting unavailable. Request was not executed.',
      );
    }
    response.setHeader('x-count', decision.remaining);
    if (!decision.allowed) {
      const seconds = Math.max(
        1,
        Math.ceil((Date.parse(decision.nextAllowedAt!) - Date.parse(decision.asOf)) / 1000),
      );
      response.setHeader('Retry-After', seconds);
      throw new HttpException(
        {
          statusCode: 429,
          message: 'Rolling-hour quota exceeded',
          retryAt: decision.nextAllowedAt,
          remaining: 0,
        },
        429,
      );
    }
    // Admission is charged even if the business handler subsequently fails.
    return next.handle();
  }
}
