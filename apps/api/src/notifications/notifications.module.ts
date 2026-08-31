import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';
import { NotificationEngineService } from './notification-engine.service';
import { NotificationWorkerService } from './notification-worker.service';
import { TelegramDeliveryService } from './delivery/telegram.delivery';
import { WebPushDeliveryService } from './delivery/web-push.delivery';
import { EmailDeliveryService } from './delivery/email.delivery';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [
    PrismaModule,
    EventsModule,
    // BullModule.registerQueue НЕТ — зарегистрировано в QueuesModule (@Global)
  ],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationEngineService,
    NotificationWorkerService,
    TelegramDeliveryService,
    WebPushDeliveryService,
    EmailDeliveryService,
  ],
  exports: [NotificationService],
})
export class NotificationsModule { }
