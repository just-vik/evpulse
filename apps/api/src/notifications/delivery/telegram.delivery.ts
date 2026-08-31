import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as TelegramBotModule from 'node-telegram-bot-api';
const TelegramBot = (TelegramBotModule as any).default ?? TelegramBotModule;
import { PrismaService } from '../../prisma/prisma.service';
import { IDeliveryService, NotificationPayload, DeliveryResult } from './delivery.interface';
import { isApiRole } from '../../runtime/runtime-role';

@Injectable()
export class TelegramDeliveryService implements IDeliveryService, OnModuleInit {
  private readonly logger = new Logger(TelegramDeliveryService.name);
  private bot: any | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!isApiRole()) return;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram delivery disabled');
      return;
    }

    this.bot = new TelegramBot(token, { polling: true });

    this.bot.on('message', async (msg) => {
      if (msg.text === '/start' && msg.from?.id) {
        const chatId = String(msg.from.id);
        this.logger.log(`Telegram /start from chatId=${chatId}`);
        // We can't auto-link without knowing the user; the frontend should do this
        await this.bot?.sendMessage(
          msg.chat.id,
          `✅ Your Telegram Chat ID is: <code>${chatId}</code>\n\nPaste this in your EVPulse notification settings.`,
          { parse_mode: 'HTML' },
        );
      }
    });

    this.bot.on('polling_error', (err) => {
      this.logger.error(`Telegram polling error: ${err.message}`);
    });
  }

  async deliver(payload: NotificationPayload): Promise<DeliveryResult> {
    if (!this.bot) {
      return { channel: 'telegram', success: false, error: 'Bot not initialized' };
    }

    try {
      const settings = await this.prisma.userNotificationSettings.findUnique({
        where: { userId: payload.userId },
        select: { telegramChatId: true, telegramEnabled: true },
      });

      if (!settings?.telegramEnabled || !settings.telegramChatId) {
        return { channel: 'telegram', success: false, error: 'Telegram not configured or disabled' };
      }

      const text = `*${this.escapeMarkdown(payload.title)}*\n${this.escapeMarkdown(payload.body)}`;
      await this.bot.sendMessage(settings.telegramChatId, text, { parse_mode: 'MarkdownV2' });
      return { channel: 'telegram', success: true };
    } catch (err: any) {
      this.logger.error(`Telegram delivery failed for user ${payload.userId}: ${err.message}`);
      return { channel: 'telegram', success: false, error: err.message };
    }
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  }
}
