import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { VehiclesModule } from './vehicles/vehicles.module';
import { TelemetryModule } from './telemetry/telemetry.module';
import { PrismaModule } from './prisma/prisma.module';
import { WebsocketsModule } from './websockets/websockets.module';
import { QueuesModule } from './queues/queues.module';
import { TripsModule } from './trips/trips.module';
import { ChargingModule } from './charging/charging.module';
import { BatteryModule } from './battery/battery.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { TeslaFleetModule } from './tesla-fleet/tesla-fleet.module';
import { InfraModule } from './infra/infra.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AiModule } from './ai/ai.module';
import { MlModule } from './ml/ml.module';
import { MetricsModule } from './metrics/metrics.module';
import { BillingModule } from './billing/billing.module';
import { EventsModule } from './events/events.module';
import { SyncModule } from './sync/sync.module';
import { AutomationsModule } from './automations/automations.module';
import { CommandsModule } from './commands/commands.module';
import { TenantModule } from './common/tenant/tenant.module';
import { ExportModule } from './export/export.module';
import { ShareModule } from './share/share.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import appConfig from './config/app.config';
import { StartupConfigGuard } from './config/startup-config.guard';
// Note: REDIS_CLIENT is provided globally by InfraModule (@Global) — no local redisProvider needed

@Module({
  controllers: [AppController],
  providers: [StartupConfigGuard],
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: ['.env.local', '.env'],
    }),

    // Rate limiting
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),

    // Cron job scheduling
    ScheduleModule.forRoot(),

    // BullMQ queue
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get('REDIS_HOST', 'localhost'),
          port: configService.get<number>('REDIS_PORT', 6379),
          password: configService.get('REDIS_PASSWORD'),
        },
      }),
      inject: [ConfigService],
    }),

    // Multi-tenant context — must come before PrismaModule so TenantContext is
    // available for injection into PrismaService.
    TenantModule,

    // Feature modules - Core
    PrismaModule,
    AuthModule,
    UsersModule,
    VehiclesModule,
    TelemetryModule,
    WebsocketsModule,
    QueuesModule,

    // Feature modules - Analytics
    TripsModule,
    ChargingModule,
    BatteryModule,
    AnalyticsModule,

    // Feature modules - Tesla Integration
    TeslaFleetModule,

    // Infrastructure (TimescaleDB setup, etc.)
    InfraModule,

    // Notification Engine
    NotificationsModule,

    // Billing & subscriptions
    BillingModule,

    // AI / Insights
    AiModule,

    // ML — range prediction, battery forecast, smart charging, anomaly detection
    MlModule,

    // Prometheus metrics — GET /metrics
    MetricsModule,

    // Event store (TelemetryEvent table) + vehicle state snapshots
    EventsModule,

    // Mobile offline-first delta sync
    SyncModule,

    // Scheduled vehicle commands (automations CRUD)
    AutomationsModule,

    // Command presets & history
    CommandsModule,

    // Data export (CSV / GPX / JSON)
    ExportModule,

    // Public share links (trip sharing via Redis-backed tokens)
    ShareModule,

    // Centralised maintenance crons (gap recovery, endtime repair)
    MaintenanceModule,
  ],
})
export class AppModule {}
