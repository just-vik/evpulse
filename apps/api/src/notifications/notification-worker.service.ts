import { Injectable, Logger } from '@nestjs/common';
import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramDeliveryService } from './delivery/telegram.delivery';
import { WebPushDeliveryService } from './delivery/web-push.delivery';
import { EmailDeliveryService } from './delivery/email.delivery';

interface DeliverJob {
  ruleId:    string;
  userId:    string;
  vehicleId: string;
  title:     string;
  body:      string;
  channels:  string[];
}

@Processor('notifications')
@Injectable()
export class NotificationWorkerService {
  private readonly logger = new Logger(NotificationWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegram: TelegramDeliveryService,
    private readonly webPush: WebPushDeliveryService,
    private readonly email: EmailDeliveryService,
  ) {}

  @Process('deliver')
  async handleDeliver(job: Job<DeliverJob>) {
    const { ruleId, userId, vehicleId, title, body, channels } = job.data;

    // Persist notification record
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        vehicleId,
        ruleId,
        type:     'rule_trigger',
        title,
        message:  body,
        body,
        channels,
        status:   'unread',
        read:     false,
      },
    });

    this.logger.log(`Notification created ${notification.id} for user ${userId} (${title})`);

    const payload = { userId, title, body, data: { vehicleId, notificationId: notification.id } };

    // Dispatch to each channel
    for (const channel of channels) {
      try {
        if (channel === 'telegram') {
          await this.telegram.deliver(payload);
        } else if (channel === 'web_push') {
          await this.webPush.deliver(payload);
        } else if (channel === 'email') {
          await this.email.deliver(payload);
        }
        // 'in_app' is handled by the persisted notification record above
      } catch (err: any) {
        this.logger.warn(`Channel ${channel} delivery error: ${err.message}`);
      }
    }
  }
}
