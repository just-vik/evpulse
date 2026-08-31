import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { IDeliveryService, NotificationPayload, DeliveryResult } from './delivery.interface';

@Injectable()
export class EmailDeliveryService implements IDeliveryService, OnModuleInit {
  private readonly logger = new Logger(EmailDeliveryService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const host = process.env.MAIL_HOST;
    const pass = process.env.MAIL_PASS;

    if (!host || !pass) {
      this.logger.warn('MAIL_HOST/MAIL_PASS not set — Email delivery disabled');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port:   Number(process.env.MAIL_PORT ?? 465),
      secure: process.env.MAIL_SECURE === 'true',
      auth: {
        user: process.env.MAIL_USER || 'resend',
        pass,
      },
    });
  }

  async deliver(payload: NotificationPayload): Promise<DeliveryResult> {
    if (!this.transporter) {
      return { channel: 'email', success: false, error: 'SMTP not configured' };
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { email: true },
      });

      if (!user) {
        return { channel: 'email', success: false, error: 'User not found' };
      }

      const settings = await this.prisma.userNotificationSettings.findUnique({
        where: { userId: payload.userId },
        select: { emailEnabled: true },
      });

      if (settings && !settings.emailEnabled) {
        return { channel: 'email', success: false, error: 'Email notifications disabled' };
      }

      await this.transporter.sendMail({
        from:    process.env.MAIL_FROM || 'noreply@evpulse.app',
        to:      user.email,
        subject: payload.title,
        html:    this.buildHtml(payload.title, payload.body),
      });

      return { channel: 'email', success: true };
    } catch (err: any) {
      this.logger.error(`Email delivery failed for user ${payload.userId}: ${err.message}`);
      return { channel: 'email', success: false, error: err.message };
    }
  }

  private buildHtml(title: string, body: string): string {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#0f0f0f;color:#e0e0e0;padding:32px">
  <div style="max-width:480px;margin:0 auto;background:#1a1a1a;border-radius:12px;padding:24px">
    <h2 style="color:#3b82f6;margin:0 0 12px">${this.htmlEscape(title)}</h2>
    <p style="margin:0 0 24px;color:#a0a0a0">${this.htmlEscape(body)}</p>
    <a href="${process.env.FRONTEND_URL || 'https://evpulse.app'}"
       style="background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">
      Open EVPulse
    </a>
    <p style="margin:24px 0 0;font-size:12px;color:#555">
      You are receiving this because you enabled email notifications in EVPulse.
    </p>
  </div>
</body>
</html>`;
  }

  private htmlEscape(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}
