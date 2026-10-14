import { existsSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppConfig } from '@/config/app-config';

// Local convenience only; in containers configuration comes from the environment.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
configureApp(app);
await app.listen(app.get(AppConfig).http.port, '0.0.0.0');
