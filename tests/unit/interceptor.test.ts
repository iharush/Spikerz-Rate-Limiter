import 'reflect-metadata';
import { jest } from '@jest/globals';
import { HttpException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { HttpArgumentsHost } from '@nestjs/common/interfaces/features/arguments-host.interface.js';
import { mock, mockDeep } from 'jest-mock-extended';
import { of } from 'rxjs';
import { QuotaRepository } from '../../apps/data-api/src/repository.js';
import { RateLimitInterceptor } from '../../apps/data-api/src/interceptor.js';
import { decision } from '../fixtures.js';

describe('RateLimitInterceptor with mocked external storage', () => {
  const repository = mock<QuotaRepository>();
  const context = mockDeep<ExecutionContext>();
  const next = mock<CallHandler>();
  const setHeader = jest.fn();
  const interceptor = new RateLimitInterceptor(repository);
  beforeEach(() => {
    jest.clearAllMocks();
    const http = mock<HttpArgumentsHost>();
    context.switchToHttp.mockReturnValue(http);
    http.getRequest.mockReturnValue({
      principal: { userId: 'verified-user' },
      headers: { 'x-user-id': 'spoofed' },
    });
    http.getResponse.mockReturnValue({ setHeader });
    next.handle.mockReturnValue(of({ ok: true }));
  });
  it.each([99, 0])('returns x-count %i after a committed admission', async (remaining) => {
    repository.consume.mockResolvedValue(decision({ remaining }));
    await interceptor.intercept(context, next);
    expect(setHeader).toHaveBeenCalledWith('x-count', remaining);
    expect(repository.consume).toHaveBeenCalledWith('verified-user', expect.any(String));
    expect(next.handle).toHaveBeenCalledTimes(1);
  });
  it('commits the denial then returns 429 and rounded-up retry information', async () => {
    repository.consume.mockResolvedValue(
      decision({
        allowed: false,
        remaining: 0,
        quotaCharged: false,
        nextAllowedAt: '2026-11-04T10:00:01.001Z',
      }),
    );
    const error = (await interceptor
      .intercept(context, next)
      .catch((value) => value)) as HttpException;
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({ retryAt: '2026-11-04T10:00:01.001Z' });
    expect(setHeader).toHaveBeenCalledWith('Retry-After', 2);
    expect(next.handle).not.toHaveBeenCalled();
  });
  it('reports underlying quota for bypassed traffic', async () => {
    repository.consume.mockResolvedValue(
      decision({ bypassed: true, bypassEnabled: true, quotaCharged: false, remaining: 10 }),
    );
    await interceptor.intercept(context, next);
    expect(setHeader).toHaveBeenCalledWith('x-count', 10);
  });
  it('fails closed without retry or handler execution on uncertain storage failure', async () => {
    repository.consume.mockRejectedValue(new Error('connection lost'));
    const error = (await interceptor
      .intercept(context, next)
      .catch((value) => value)) as HttpException;
    expect(error.getStatus()).toBe(503);
    expect(next.handle).not.toHaveBeenCalled();
    expect(repository.consume).toHaveBeenCalledTimes(1);
  });
});
