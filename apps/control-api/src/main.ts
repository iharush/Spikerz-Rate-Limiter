import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { TokenVerifier } from '../../../packages/auth/src/index.js';
import { ControlModule } from './app.js';
import { ControlRepository } from './repository.js';

async function main() {
  const app = await NestFactory.create(ControlModule);
  await app.get(ControlRepository).initialize();
  await app.get(TokenVerifier).initialize();
  app.enableShutdownHooks();
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:8080' });
  await app.listen(Number(process.env.PORT ?? 3002), '0.0.0.0');
}
void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
