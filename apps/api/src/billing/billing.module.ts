import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import billingConfig from './billing.config';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { StripeWebhookController } from './stripe-webhook.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { ApiUsageService } from './api-usage.service';

@Module({
  imports: [ConfigModule.forFeature(billingConfig), PrismaModule, RedisModule],
  controllers: [BillingController, StripeWebhookController],
  providers: [BillingService, ApiUsageService],
  exports: [BillingService, ApiUsageService],
})
export class BillingModule {}
