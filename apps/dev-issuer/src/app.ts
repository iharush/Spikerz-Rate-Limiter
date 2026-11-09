import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Injectable,
  Module,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AdminGuard, type AuthRequest, TokenVerifier } from '../../../packages/auth/src/index.js';

const accounts = ['admin', 'alice', 'bob', 'charlie'];

@Injectable()
export class IssuerKeys {
  privateKey = '';
  publicKey = '';
}

@Controller()
class IssuerController {
  constructor(private readonly keys: IssuerKeys) {}

  @Get('health') health() {
    return { ok: true };
  }
  @Get('public-key') @Header('content-type', 'text/plain') key() {
    return this.keys.publicKey;
  }
  @Get('accounts') accounts() {
    return accounts.map((subject) => ({ subject, role: subject === 'admin' ? 'admin' : 'user' }));
  }
  private issueToken(subject: string, expiresIn: number, issuedAt = Math.floor(Date.now() / 1000)) {
    return {
      token: jwt.sign(
        { role: subject === 'admin' ? 'admin' : 'user', iat: issuedAt },
        this.keys.privateKey,
        {
          algorithm: 'RS256',
          issuer: process.env.AUTH_ISSUER ?? 'spikerz-demo',
          audience: process.env.AUTH_AUDIENCE ?? 'spikerz',
          subject,
          expiresIn,
        },
      ),
      expiresIn,
    };
  }
  @Post('token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  token(@Body() body: unknown) {
    const parsed = z
      .object({ subject: z.enum(['admin', 'alice', 'bob', 'charlie']), password: z.string() })
      .strict()
      .safeParse(body);
    if (!parsed.success || parsed.data.password !== process.env.DEMO_PASSWORD)
      throw new UnauthorizedException('Invalid demo credentials');
    return this.issueToken(parsed.data.subject, 3600);
  }
  @Post('demo-token')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AdminGuard)
  demoToken(@Body() body: unknown, @Req() request: AuthRequest) {
    const parsed = z
      .object({ subject: z.enum(['alice', 'bob', 'charlie']) })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Choose a seeded demo user');
    // Demo credentials must not outlive the admin session that authorized them.
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresIn = Math.min(300, Math.floor(request.principal.expiresAt / 1000) - issuedAt);
    if (expiresIn <= 0) throw new UnauthorizedException('Admin session expired');
    return this.issueToken(parsed.data.subject, expiresIn, issuedAt);
  }
}

@Module({ controllers: [IssuerController], providers: [IssuerKeys, TokenVerifier, AdminGuard] })
export class IssuerModule {}
