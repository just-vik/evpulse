import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiService } from './ai.service';
import { AIGuardService } from './ai-guard.service';
import { AIExecutorService } from './ai-executor.service';
import { AIAgentService } from './ai-agent.service';
import { AiController } from './ai.controller';
import { AiContextBuilder } from './ai-context.builder';
import { EmbeddingWorker } from './embedding.worker';
import { AiEmbeddingScheduler } from './ai-embedding.scheduler';
import { InsightsBatchService } from './insights-batch.service';
import { AiEntitlementGuard } from './ai-entitlement.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { TeslaFleetModule } from '../tesla-fleet/tesla-fleet.module';
import { RedisModule } from '../redis/redis.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [ConfigModule, PrismaModule, TeslaFleetModule, RedisModule, VehiclesModule, BillingModule],
  controllers: [AiController],
  providers: [
    AiService,
    AIGuardService,
    AIExecutorService,
    AIAgentService,
    AiContextBuilder,
    EmbeddingWorker,
    AiEmbeddingScheduler,
    InsightsBatchService,
    AiEntitlementGuard,
  ],
  exports: [AiService, AIGuardService, AIExecutorService, AIAgentService, InsightsBatchService],
})
export class AiModule {}
