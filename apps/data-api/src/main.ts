import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { TokenVerifier } from '../../../packages/auth/src/index.js';
import { DataModule } from './app.js';
import { QuotaRepository } from './repository.js';

async function main() {
  const app = await NestFactory.create(DataModule);
  await app.get(QuotaRepository).initialize();
  await app.get(TokenVerifier).initialize();
  app.enableShutdownHooks();
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:8080',
    exposedHeaders: ['x-count', 'Retry-After'],
  });
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
