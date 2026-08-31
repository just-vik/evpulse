import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';
import { IDeliveryService, NotificationPayload, DeliveryResult } from './delivery.interface';

@Injectable()
export class WebPushDeliveryService implements IDeliveryService, OnModuleInit {
  private readonly logger = new Logger(WebPushDeliveryService.name);
  private enabled = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const publicKey  = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject    = process.env.VAPID_SUBJECT || 'mailto:noreply@evpulse.app';

    if (!publicKey || !privateKey) {
      this.logger.warn('VAPID keys not set — Web Push delivery disabled');
      return;
    }

    webpush.setVapidDetails(subject, publicKey, privateKey);
    this.enabled = true;
  }

  async deliver(payload: NotificationPayload): Promise<DeliveryResult> {
    if (!this.enabled) {
      return { channel: 'web_push', success: false, error: 'VAPID not configured' };
    }

    const subs = await this.prisma.webPushSubscription.findMany({
      where: { userId: payload.userId },
    });

    if (!subs.length) {
      return { channel: 'web_push', success: false, error: 'No push subscriptions' };
    }

    const message = JSON.stringify({
      title: payload.title,
      body:  payload.body,
      data:  payload.data ?? {},
    });

    let successCount = 0;
    const staleIds: string[] = [];

    await Promise.allSettled(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            message,
          );
          successCount++;
        } catch (err: any) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            staleIds.push(sub.id);
          } else {
            this.logger.warn(`Web push failed for sub ${sub.id}: ${err.message}`);
          }
        }
      }),
    );

    // Clean up expired subscriptions
    if (staleIds.length) {
      await this.prisma.webPushSubscription.deleteMany({ where: { id: { in: staleIds } } });
    }

    if (successCount > 0) {
      return { channel: 'web_push', success: true };
    }
    return { channel: 'web_push', success: false, error: 'All push deliveries failed' };
  }
}
