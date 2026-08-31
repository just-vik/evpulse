import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TeslaOAuthService } from './tesla-oauth.service';
import { isWorkerRole } from '../runtime/runtime-role';

/**
 * Token Refresh Worker
 * 
 * Automatically refreshes Tesla OAuth tokens every 30 minutes
 * Prevents tokens from expiring and breaking user sessions
 */
@Injectable()
export class TokenRefreshWorker {
  private readonly logger = new Logger(TokenRefreshWorker.name);

  constructor(
    private prisma: PrismaService,
    private teslaOAuth: TeslaOAuthService,
  ) {}

  /**
   * Refresh tokens for all users
   * Runs every 30 minutes
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async refreshAllTokens(): Promise<void> {
    if (!isWorkerRole()) return;
    try {
      this.logger.log('Starting token refresh cycle');

      const accounts = await this.prisma.teslaAccount.findMany({
        select: { userId: true, expiresAt: true },
      });

      let refreshed = 0;
      let failed = 0;

      for (const account of accounts) {
        try {
          // Check if token is expiring soon (within 15 minutes)
          const expiringThreshold = new Date(Date.now() + 15 * 60 * 1000);
          if (account.expiresAt < expiringThreshold) {
            await this.refreshUserToken(account.userId);
            refreshed++;
          }
        } catch (error) {
          this.logger.error(
            `Failed to refresh token for user ${account.userId}: ${error.message}`,
          );
          failed++;
        }
      }

      this.logger.log(
        `Token refresh cycle complete: ${refreshed} refreshed, ${failed} failed out of ${accounts.length} total`,
      );
    } catch (error) {
      this.logger.error(`Token refresh cycle failed: ${error.message}`);
    }
  }

  /**
   * Refresh token for specific user
   */
  private async refreshUserToken(userId: string): Promise<void> {
    const tokens = await this.teslaOAuth.getTokens(userId);

    if (!tokens) {
      this.logger.warn(`No tokens found for user ${userId}`);
      return;
    }

    try {
      // Refresh tokens via Tesla OAuth service
      const newTokens = await this.teslaOAuth.getValidAccessToken(userId);

      if (newTokens) {
        this.logger.debug(`Token refreshed for user ${userId}`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to refresh token for user ${userId}: ${error.message}`,
      );
      // Don't throw - continue with other users
    }
  }

  /**
   * Manual trigger for token refresh (for testing)
   */
  async refreshToken(userId: string): Promise<{ success: boolean; message: string }> {
    try {
      await this.refreshUserToken(userId);
      return { success: true, message: `Token refreshed for user ${userId}` };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }
}
