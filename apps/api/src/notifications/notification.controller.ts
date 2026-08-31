import {
  Controller, Get, Post, Put, Delete, Patch,
  Param, Body, Query, Request, UseGuards,
  ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationService } from './notification.service';
import { AuditLogService } from '../events/audit-log.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { SubscribePushDto } from './dto/subscribe-push.dto';

@Controller('notifications')

@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(
    private readonly svc: NotificationService,
    private readonly auditLog: AuditLogService,
  ) { }

  // ── History ─────────────────────────────────────────────────────────────────

  @Get()
  getHistory(
    @Request() req: any,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('pageSize', new DefaultValuePipe(20), ParseIntPipe) pageSize: number,
  ) {
    return this.svc.getHistory(req.user.id, page, pageSize);
  }

  @Get('unread-count')
  getUnreadCount(@Request() req: any) {
    return this.svc.getUnreadCount(req.user.id).then((count) => ({ count }));
  }

  @Patch(':id/read')
  markRead(@Request() req: any, @Param('id') id: string) {
    return this.svc.markRead(req.user.id, id);
  }

  @Post('read-all')
  markAllRead(@Request() req: any) {
    return this.svc.markAllRead(req.user.id);
  }

  // ── Rules ────────────────────────────────────────────────────────────────────

  @Get('rules')
  getRules(@Request() req: any) {
    return this.svc.getRules(req.user.id);
  }

  @Post('rules')
  async createRule(@Request() req: any, @Body() dto: CreateRuleDto) {
    const rule = await this.svc.createRule(req.user.id, dto);
    this.auditLog.record({
      userId: req.user.id,
      type: 'rule',
      action: 'rule.created',
      targetType: 'rule',
      targetId: rule?.id,
      metadata: { name: dto.name },
    });
    return rule;
  }

  @Put('rules/:id')
  async updateRule(@Request() req: any, @Param('id') id: string, @Body() dto: CreateRuleDto) {
    const rule = await this.svc.updateRule(req.user.id, id, dto);
    this.auditLog.record({
      userId: req.user.id,
      type: 'rule',
      action: 'rule.updated',
      targetType: 'rule',
      targetId: id,
      metadata: { name: dto.name },
    });
    return rule;
  }

  @Delete('rules/:id')
  async deleteRule(@Request() req: any, @Param('id') id: string) {
    const result = await this.svc.deleteRule(req.user.id, id);
    this.auditLog.record({
      userId: req.user.id,
      type: 'rule',
      action: 'rule.deleted',
      targetType: 'rule',
      targetId: id,
    });
    return result;
  }

  @Get('rules/:id/history')
  getRuleHistory(
    @Request() req: any,
    @Param('id') id: string,
    @Query('limit', new DefaultValuePipe(5), ParseIntPipe) limit: number,
  ) {
    return this.svc.getRuleHistory(req.user.id, id, limit);
  }

  // ── Web Push ─────────────────────────────────────────────────────────────────

  @Get('push/vapid-key')
  getVapidKey() {
    return { publicKey: this.svc.getVapidPublicKey() };
  }

  @Post('push/subscribe')
  subscribePush(@Request() req: any, @Body() dto: SubscribePushDto) {
    return this.svc.subscribePush(req.user.id, dto);
  }

  @Post('push/unsubscribe')
  unsubscribePush(@Request() req: any, @Body('endpoint') endpoint: string) {
    return this.svc.unsubscribePush(req.user.id, endpoint);
  }

  // ── Notification settings (Telegram + toggles) ────────────────────────────

  @Get('settings')
  getSettings(@Request() req: any) {
    return this.svc.getTelegramSettings(req.user.id);
  }

  @Put('settings')
  updateSettings(
    @Request() req: any,
    @Body() body: {
      telegramChatId?: string;
      telegramEnabled?: boolean;
      webPushEnabled?: boolean;
      emailEnabled?: boolean;
    },
  ) {
    return this.svc.updateNotificationSettings(req.user.id, body);
  }
}
