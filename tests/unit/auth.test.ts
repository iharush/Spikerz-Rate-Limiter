import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { mock, mockDeep } from 'jest-mock-extended';
import type { ExecutionContext } from '@nestjs/common';
import type { HttpArgumentsHost } from '@nestjs/common/interfaces/features/arguments-host.interface.js';
import { AdminGuard, TokenVerifier, UserGuard } from '../../packages/auth/src/index.js';

describe('verified authentication', () => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const verifier = new TokenVerifier();
  const original = { ...process.env };
  const token = (options: jwt.SignOptions = {}, role = 'user') =>
    jwt.sign({ role }, keys.privateKey, {
      algorithm: 'RS256',
      issuer: 'spikerz-demo',
      audience: 'spikerz',
      subject: 'alice',
      expiresIn: '1h',
      ...options,
    });
  beforeAll(async () => {
    process.env.AUTH_PUBLIC_KEY = keys.publicKey;
    await verifier.initialize();
  });
  afterAll(() => {
    process.env = original;
  });
  it('uses a verified issuer/subject identity', () => {
    expect(verifier.authenticate(token())).toMatchObject({
      userId: '["spikerz-demo","alice"]',
      role: 'user',
    });
  });
  it.each([undefined, 'garbage'])('rejects missing or malformed tokens', (value) => {
    expect(() => verifier.authenticate(value)).toThrow();
  });
  it('rejects expired tokens and wrong issuer/audience', () => {
    for (const options of [{ expiresIn: -1 }, { issuer: 'attacker' }, { audience: 'other' }])
      expect(() => verifier.authenticate(token(options))).toThrow();
  });
  it('rejects a token signed with an untrusted key', () => {
    expect(() =>
      verifier.authenticate(
        jwt.sign({ sub: 'alice', role: 'admin' }, 'forged', {
          algorithm: 'HS256',
          issuer: 'spikerz-demo',
          audience: 'spikerz',
          expiresIn: '1h',
        }),
      ),
    ).toThrow();
  });
  it('ignores spoofed identity headers and requires admin role', () => {
    const context = mockDeep<ExecutionContext>();
    const http = mock<HttpArgumentsHost>();
    context.switchToHttp.mockReturnValue(http);
    const request = { headers: { authorization: `Bearer ${token()}`, 'x-user-id': 'admin' } };
    http.getRequest.mockReturnValue(request);
    expect(new UserGuard(verifier).canActivate(context)).toBe(true);
    expect(request).toMatchObject({ principal: { userId: '["spikerz-demo","alice"]' } });
    expect(() => new AdminGuard(verifier).canActivate(context)).toThrow('Admin role required');
  });
});
