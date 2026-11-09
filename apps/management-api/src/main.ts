import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { TokenVerifier } from '../../../packages/auth/src/index.js';
import { ManagementModule } from './app.js';
import { ManagementRepository } from './repository.js';

async function main() {
  const app = await NestFactory.create(ManagementModule, { bodyParser: false });
  app.use(json({ limit: '1mb' }));
  await app.get(ManagementRepository).initialize();
  await app.get(TokenVerifier).initialize();
  app.enableShutdownHooks();
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:8080' });
  await app.listen(Number(process.env.PORT ?? 3003), '0.0.0.0');
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
