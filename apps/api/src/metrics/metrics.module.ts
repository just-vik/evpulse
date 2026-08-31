import { Module, Global, forwardRef } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';
import { ProductMetricsCronService } from './product-metrics.cron';
import { PrismaModule } from '../prisma/prisma.module';
import { QueuesModule } from '../queues/queues.module';

@Global()
@Module({
  imports: [PrismaModule, forwardRef(() => QueuesModule)],
  controllers: [MetricsController],
  providers: [MetricsService, ProductMetricsCronService],
  exports: [MetricsService],
})
export class MetricsModule {}
