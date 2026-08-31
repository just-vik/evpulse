import './otel-bootstrap'; // must be first — patches Node.js modules before any other import
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import * as compression from 'compression';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { getAppRole, isApiRole } from './runtime/runtime-role';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const appRole = getAppRole();

  // Worker-only runtime: boot DI/context and background services without HTTP server.
  if (!isApiRole()) {
    await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    });
    logger.log(`EVPulse worker runtime started (APP_ROLE=${appRole})`);
    return;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log', 'debug', 'verbose'],
    rawBody: true,
  });

  // Security middleware
  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());

  // Disable HTTP caching for API responses (telemetry & analytics must always be fresh)
  app.use((req, res, next) => {
    if (req.url.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // CORS configuration
  const allowedOrigins = [
    process.env.FRONTEND_URL,
    'https://evpulse.app',
    'https://www.evpulse.app',
    'https://api.evpulse.app',
    'http://localhost:3000',
    'http://localhost:3001',
  ].filter(Boolean) as string[];

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Allow any localhost port only in non-production environments
      if (process.env.NODE_ENV !== 'production') {
        if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
          return callback(null, true);
        }
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Global prefix (root, health, and metrics endpoints excluded)
  app.setGlobalPrefix('api/v1', { exclude: ['/', '/health', '/metrics'] });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  const port = process.env.PORT || 4000;

  // Swagger docs — dev only (never expose route/DTO schema in production)
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('EVPulse Tesla Telemetry API')
      .setDescription('API for the EVPulse Tesla telemetry platform')
      .setVersion('1.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          name: 'JWT',
          description: 'Enter JWT token',
          in: 'header',
        },
        'JWT-auth',
      )
      .addTag('auth', 'Authentication endpoints')
      .addTag('vehicles', 'Vehicle management endpoints')
      .addTag('telemetry', 'Telemetry data endpoints')
      .addTag('users', 'User management endpoints')
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document, {
      swaggerOptions: {
        persistAuthorization: true,
      },
    });

    logger.log(`Swagger docs available at: http://localhost:${port}/api/docs`);
  }

  await app.listen(port);

  logger.log(`EVPulse backend running on: http://localhost:${port}/api/v1 (APP_ROLE=${appRole})`);
}

bootstrap();
