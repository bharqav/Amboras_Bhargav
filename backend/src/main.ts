import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Ensure dashboard poll lines (`Logger.log`) show in dev and production shells.
    logger: ['error', 'warn', 'log'],
  });
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const originsRaw = config.get<string>('CORS_ORIGIN', 'http://localhost:3000');
  const explicitOrigins = originsRaw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const nodeEnv = config.get<string>('NODE_ENV', 'development');

  function isLocalDevOrigin(origin: string): boolean {
    try {
      const u = new URL(origin);
      return (
        u.hostname === 'localhost' ||
        u.hostname === '127.0.0.1' ||
        u.hostname === '[::1]'
      );
    } catch {
      return false;
    }
  }

  /** With `credentials: true`, the browser requires a concrete ACAO (not `*`). */
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (explicitOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      if (nodeEnv !== 'production' && isLocalDevOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'X-Requested-With'],
    exposedHeaders: ['Content-Type'],
    optionsSuccessStatus: 204,
  });

  const port = Number(config.get('PORT', 4000));
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Backend listening on http://localhost:${port}/api/v1`);
}

bootstrap();
