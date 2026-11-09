import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { TokenVerifier } from '../../../packages/auth/src/index.js';
import { IssuerKeys, IssuerModule } from './app.js';

async function main() {
  if (process.env.ENABLE_DEMO_AUTH !== 'true' || process.env.NODE_ENV === 'production')
    throw new Error('Demo issuer is development-only');
  if (!process.env.DEMO_PASSWORD) throw new Error('Set DEMO_PASSWORD');
  const directory = process.env.KEY_DIRECTORY ?? '.secrets';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(`${directory}/private.pem`)) {
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(`${directory}/private.pem`, keys.privateKey, { mode: 0o600 });
    writeFileSync(`${directory}/public.pem`, keys.publicKey, { mode: 0o644 });
  }
  const app = await NestFactory.create(IssuerModule);
  const keys = app.get(IssuerKeys);
  keys.privateKey = readFileSync(`${directory}/private.pem`, 'utf8');
  keys.publicKey = readFileSync(`${directory}/public.pem`, 'utf8');
  await app.get(TokenVerifier).initialize(keys.publicKey);
  app.enableShutdownHooks();
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:8080' });
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
