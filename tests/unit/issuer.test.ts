import 'reflect-metadata';
import { generateKeyPairSync } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { IssuerKeys, IssuerModule } from '../../apps/dev-issuer/src/app.js';
import { TokenVerifier } from '../../packages/auth/src/index.js';

describe('demo user token issuance', () => {
  const original = { ...process.env };
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const sign = (role = 'admin', options: jwt.SignOptions = {}) =>
    jwt.sign({ role }, keys.privateKey, {
      algorithm: 'RS256',
      subject: role === 'admin' ? 'admin' : 'alice',
      issuer: 'spikerz-demo',
      audience: 'spikerz',
      expiresIn: 3600,
      ...options,
    });
  let app: INestApplication;
  let verifier: TokenVerifier;
  beforeAll(async () => {
    process.env.AUTH_ISSUER = 'spikerz-demo';
    process.env.AUTH_AUDIENCE = 'spikerz';
    process.env.DEMO_PASSWORD = 'test-login-password';
    const module = await Test.createTestingModule({ imports: [IssuerModule] }).compile();
    app = module.createNestApplication();
    Object.assign(app.get(IssuerKeys), keys);
    verifier = app.get(TokenVerifier);
    await verifier.initialize(keys.publicKey);
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    process.env = original;
  });

  it.each(['alice', 'bob', 'charlie'])(
    'issues a short-lived user token for %s without a password',
    async (subject) => {
      const response = await request(app.getHttpServer())
        .post('/demo-token')
        .set('Authorization', `Bearer ${sign()}`)
        .send({ subject })
        .expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body.expiresIn).toBe(300);
      expect(verifier.authenticate(response.body.token)).toMatchObject({
        userId: JSON.stringify(['spikerz-demo', subject]),
        role: 'user',
      });
    },
  );

  it('never lets a user token outlive the authorizing admin token', async () => {
    const admin = sign('admin', { expiresIn: 30 });
    const response = await request(app.getHttpServer())
      .post('/demo-token')
      .set('Authorization', `Bearer ${admin}`)
      .send({ subject: 'alice' })
      .expect(200);
    expect(response.body.expiresIn).toBeLessThanOrEqual(30);
    const parent = jwt.decode(admin) as jwt.JwtPayload;
    const child = jwt.decode(response.body.token) as jwt.JwtPayload;
    expect(child.exp).toBeLessThanOrEqual(parent.exp!);
  });

  it.each([
    undefined,
    'garbage',
    sign('admin', { expiresIn: -1 }),
    sign('admin', { issuer: 'other' }),
    sign('admin', { audience: 'other' }),
    jwt.sign({ role: 'admin' }, 'untrusted-key', { subject: 'admin', expiresIn: 3600 }),
  ])('rejects missing, expired, or invalid admin credentials (%#)', async (token) => {
    const call = request(app.getHttpServer()).post('/demo-token');
    if (token) call.set('Authorization', `Bearer ${token}`);
    await call.send({ subject: 'alice' }).expect(401);
  });

  it('prevents ordinary users from issuing tokens', async () => {
    await request(app.getHttpServer())
      .post('/demo-token')
      .set('Authorization', `Bearer ${sign('user')}`)
      .send({ subject: 'bob' })
      .expect(403);
  });

  it.each([
    { subject: 'admin' },
    { subject: 'unknown' },
    {},
    { subject: 'alice', role: 'admin' },
    { subject: 'alice', password: 'test-login-password' },
  ])('rejects unsupported identities and extra credential fields (%#)', async (body) => {
    await request(app.getHttpServer())
      .post('/demo-token')
      .set('Authorization', `Bearer ${sign()}`)
      .send(body)
      .expect(400);
  });

  it('still requires a password for the initial admin login', async () => {
    await request(app.getHttpServer()).post('/token').send({ subject: 'admin' }).expect(401);
    const response = await request(app.getHttpServer())
      .post('/token')
      .send({ subject: 'admin', password: 'test-login-password' })
      .expect(200);
    expect(verifier.authenticate(response.body.token).role).toBe('admin');
  });
});
