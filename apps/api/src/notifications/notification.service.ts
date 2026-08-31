import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { SubscribePushDto } from './dto/subscribe-push.dto';

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Notification history ────────────────────────────────────────────────────

  async getHistory(userId: string, page = 1, pageSize = 20) {
    const skip  = (page - 1) * pageSize;
    const [data, total] = await Promise.all([
      this.prisma.notification.findMany({
        where:   { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take:    pageSize,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);
    return { data, total, page, pageSize, hasMore: skip + data.length < total };
  }

  async markRead(userId: string, id: string) {
    const n = await this.prisma.notification.findFirst({ where: { id, userId } });
    if (!n) throw new NotFoundException('Notification not found');
    return this.prisma.notification.update({
      where: { id },
      data:  { read: true, status: 'read' },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data:  { read: true, status: 'read' },
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, read: false } });
  }

  // ── Notification rules ──────────────────────────────────────────────────────

  async getRules(userId: string) {
    return this.prisma.notificationRule.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }

  async createRule(userId: string, dto: CreateRuleDto) {
    return this.prisma.notificationRule.create({
      data: {
        userId,
        vehicleId:    dto.vehicleId ?? null,
        name:         dto.name,
        ruleType:     dto.triggerType,
        triggerType:  dto.triggerType,
        triggerValue: (dto.triggerValue ?? {}) as any,
        cooldownSec:  dto.cooldownSec ?? 3600,
        channels:     dto.channels ?? ['in_app'],
        enabled:      dto.enabled ?? true,
      },
    });
  }

  async updateRule(userId: string, id: string, dto: Partial<CreateRuleDto> & { conditions?: any; actions?: any }) {
    const rule = await this.prisma.notificationRule.findFirst({ where: { id, userId } });
    if (!rule) throw new NotFoundException('Rule not found');
    return this.prisma.notificationRule.update({
      where: { id },
      data: {
        ...(dto.name         != null && { name: dto.name }),
        ...(dto.vehicleId    != null && { vehicleId: dto.vehicleId }),
        ...(dto.triggerType  != null && { triggerType: dto.triggerType, ruleType: dto.triggerType }),
        ...(dto.triggerValue != null && { triggerValue: dto.triggerValue as any }),
        ...(dto.cooldownSec  != null && { cooldownSec: dto.cooldownSec }),
        ...(dto.channels     != null && { channels: dto.channels }),
        ...(dto.enabled      != null && { enabled: dto.enabled }),
        ...(dto.conditions   !== undefined && { conditions: dto.conditions }),
        ...(dto.actions      !== undefined && { actions: dto.actions }),
      },
    });
  }

  async deleteRule(userId: string, id: string) {
    const rule = await this.prisma.notificationRule.findFirst({ where: { id, userId } });
    if (!rule) throw new NotFoundException('Rule not found');
    await this.prisma.notificationRule.delete({ where: { id } });
    return { deleted: true };
  }

  async getRuleHistory(userId: string, ruleId: string, limit = 5) {
    const rule = await this.prisma.notificationRule.findFirst({ where: { id: ruleId, userId } });
    if (!rule) throw new NotFoundException('Rule not found');
    return this.prisma.notification.findMany({
      where: { userId, ruleId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 20),
      select: { id: true, title: true, body: true, createdAt: true, vehicleId: true, read: true },
    });
  }

  // ── Web Push subscriptions ──────────────────────────────────────────────────

  async subscribePush(userId: string, dto: SubscribePushDto) {
    return this.prisma.webPushSubscription.upsert({
      where:  { endpoint: dto.endpoint },
      update: { p256dh: dto.p256dh, auth: dto.auth, userAgent: dto.userAgent },
      create: { userId, endpoint: dto.endpoint, p256dh: dto.p256dh, auth: dto.auth, userAgent: dto.userAgent },
    });
  }

  async unsubscribePush(userId: string, endpoint: string) {
    await this.prisma.webPushSubscription.deleteMany({ where: { userId, endpoint } });
    return { deleted: true };
  }

  // ── Telegram settings ───────────────────────────────────────────────────────

  async getTelegramSettings(userId: string) {
    return this.prisma.userNotificationSettings.findUnique({
      where:  { userId },
      select: { telegramChatId: true, telegramEnabled: true, webPushEnabled: true, emailEnabled: true },
    });
  }

  async updateNotificationSettings(userId: string, data: {
    telegramChatId?: string | null;
    telegramEnabled?: boolean;
    webPushEnabled?: boolean;
    emailEnabled?: boolean;
  }) {
    return this.prisma.userNotificationSettings.upsert({
      where:  { userId },
      update: data,
      create: { userId, ...data },
    });
  }

  /** Returns the VAPID public key so the frontend can create a push subscription */
  getVapidPublicKey(): string {
    return process.env.VAPID_PUBLIC_KEY ?? '';
  }
}
