import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Request } from 'express';

export interface Principal {
  userId: string;
  role: 'user' | 'admin';
  expiresAt: number;
}
export type AuthRequest = Request & { principal: Principal };

@Injectable()
export class TokenVerifier {
  private key = '';
  async initialize(publicKey?: string): Promise<void> {
    if (publicKey) {
      this.key = publicKey;
    } else if (process.env.AUTH_PUBLIC_KEY) {
      this.key = process.env.AUTH_PUBLIC_KEY.replace(/\\n/g, '\n');
    } else if (process.env.ENABLE_DEMO_AUTH === 'true' && process.env.AUTH_ISSUER_URL) {
      const response = await fetch(`${process.env.AUTH_ISSUER_URL}/public-key`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Cannot load demo public key');
      this.key = await response.text();
    } else {
      throw new Error('Set AUTH_PUBLIC_KEY or explicitly enable development authentication');
    }
  }
  authenticate(token: unknown): Principal {
    try {
      if (typeof token !== 'string' || token.length > 8192) throw new Error('Missing token');
      const claims = jwt.verify(token, this.key, {
        algorithms: ['RS256'],
        issuer: process.env.AUTH_ISSUER ?? 'spikerz-demo',
        audience: process.env.AUTH_AUDIENCE ?? 'spikerz',
      }) as JwtPayload;
      if (
        typeof claims.sub !== 'string' ||
        !claims.sub ||
        typeof claims.iss !== 'string' ||
        typeof claims.exp !== 'number' ||
        !['user', 'admin'].includes(claims.role)
      )
        throw new Error('Invalid claims');
      // JSON tuple encoding is unambiguous even when subjects contain punctuation.
      const userId = JSON.stringify([claims.iss, claims.sub]);
      if (userId.length > 300) throw new Error('Identity too long');
      return { userId, role: claims.role, expiresAt: claims.exp * 1000 };
    } catch {
      throw new UnauthorizedException('A valid access token is required');
    }
  }
}

@Injectable()
export class UserGuard implements CanActivate {
  constructor(private readonly verifier: TokenVerifier) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
    request.principal = this.verifier.authenticate(match?.[1]);
    return true;
  }
}

@Injectable()
export class AdminGuard extends UserGuard {
  canActivate(context: ExecutionContext): boolean {
    super.canActivate(context);
    if (context.switchToHttp().getRequest<AuthRequest>().principal.role !== 'admin')
      throw new ForbiddenException('Admin role required');
    return true;
  }
}

@Injectable()
export class InternalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const actual = context.switchToHttp().getRequest<Request>().headers['x-service-key'];
    const expected = process.env.INTERNAL_SERVICE_KEY;
    if (!expected || expected.length < 32)
      throw new Error('INTERNAL_SERVICE_KEY must contain at least 32 characters');
    if (
      typeof actual !== 'string' ||
      Buffer.byteLength(actual) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
    )
      throw new UnauthorizedException();
    return true;
  }
}
