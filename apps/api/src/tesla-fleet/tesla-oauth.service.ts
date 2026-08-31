import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TeslaFleetService } from './tesla-fleet.service';
import { RedisService } from '../redis/redis.service';

/**
 * TeslaOAuthService — Secure token management
 *
 * Security model:
 * - AES-256-GCM with a UNIQUE random IV per encryption call
 * - IV (12 bytes) + authTag (16 bytes) prepended to ciphertext in base64
 * - Format on disk: "<iv_hex>:<authTag_hex>:<ciphertext_base64>"
 * - Backward compat: legacy CBC tokens (no ':' separator) decrypted with stored key+iv
 */
@Injectable()
export class TeslaOAuthService {
  private readonly logger = new Logger(TeslaOAuthService.name);
  private readonly encryptionKey: Buffer;
  // Legacy IV kept only for migrating old CBC-encrypted tokens
  private readonly legacyIv: Buffer | null = null;

  private readonly AUTH_EXPIRED_PREFIX = 'tesla:auth:expired:';

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly teslaFleet: TeslaFleetService,
    private readonly redis: RedisService,
  ) {
    const keyHex = this.configService.get<string>('TESLA_ENCRYPTION_KEY');
    const ivHex  = this.configService.get<string>('TESLA_ENCRYPTION_IV');

    if (!keyHex) {
      const env = this.configService.get<string>('NODE_ENV') ?? 'development';

      if (env !== 'development') {
        this.logger.error(
          'TESLA_ENCRYPTION_KEY is not set. ' +
          'In non-development environments this is a hard failure, because Tesla tokens would be irrecoverable.',
        );
        throw new Error('TESLA_ENCRYPTION_KEY must be configured in production environments');
      }

      this.logger.warn(
        'TESLA_ENCRYPTION_KEY not set. Using temporary in-memory key — Tesla tokens will be lost on restart. ' +
        'Set TESLA_ENCRYPTION_KEY (64 hex chars) in secrets/.env for persistent storage.',
      );
      this.encryptionKey = crypto.randomBytes(32);
    } else {
      this.encryptionKey = Buffer.from(keyHex, 'hex');
    }

    // Keep legacy IV only if provided — used to decrypt tokens stored with old scheme
    if (ivHex) {
      this.legacyIv = Buffer.from(ivHex, 'hex');
    }
  }

  // ─────────────────────────── Crypto helpers ───────────────────────────────

  /**
   * Encrypt with AES-256-GCM, unique IV per call.
   * Output: "<iv_hex>:<authTag_hex>:<ciphertext_base64>"
   */
  private encrypt(plaintext: string): string {
    const iv     = crypto.randomBytes(12); // 96-bit IV — optimal for GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag    = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('base64')}`;
  }

  /**
   * Decrypt — handles both new GCM format and legacy CBC format.
   */
  private decrypt(ciphertext: string): string {
    // New format: "iv:authTag:data"
    if (ciphertext.includes(':')) {
      const parts = ciphertext.split(':');
      if (parts.length === 3) {
        const [ivHex, tagHex, data] = parts;
        const iv      = Buffer.from(ivHex, 'hex');
        const tag     = Buffer.from(tagHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
        decipher.setAuthTag(tag);
        return decipher.update(data, 'base64', 'utf8') + decipher.final('utf8');
      }
    }

    // Legacy CBC format (migrate on next write)
    if (!this.legacyIv) {
      throw new Error('Cannot decrypt legacy token: TESLA_ENCRYPTION_IV not configured');
    }
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.encryptionKey, this.legacyIv);
    return decipher.update(ciphertext, 'base64', 'utf8') + decipher.final('utf8');
  }

  // ─────────────────────────── Token storage ────────────────────────────────

  /**
   * Persist OAuth tokens. Re-encrypts with fresh IV on every write.
   *
   * Handles Tesla's rare case where refresh_token changes:
   * - If new refresh_token provided → store it
   * - If refresh_token omitted → preserve existing one (fallback)
   */
  async storeTokens(
    userId: string,
    email: string,
    tokens: {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    },
  ): Promise<void> {
    if (!tokens?.access_token || typeof tokens.expires_in !== 'number') {
      throw new Error('Invalid Tesla OAuth token response: access_token or expires_in missing');
    }

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // If refresh_token not provided, try to get existing one
    let refreshTokenEncrypted: string | null = null;
    if (tokens.refresh_token) {
      refreshTokenEncrypted = this.encrypt(tokens.refresh_token);
    } else {
      // Preserve existing refresh token as fallback when possible
      const existing = await this.prisma.teslaAccount.findUnique({ where: { userId } });
      if (!existing?.refreshTokenEncrypted) {
        throw new Error('Missing refresh_token in Tesla response and no existing token to preserve');
      }
      refreshTokenEncrypted = existing.refreshTokenEncrypted;
    }

    await this.prisma.teslaAccount.upsert({
      where:  { userId },
      create: {
        userId,
        email,
        accessTokenEncrypted:  this.encrypt(tokens.access_token),
        refreshTokenEncrypted: refreshTokenEncrypted,
        expiresAt,
      },
      update: {
        email,
        accessTokenEncrypted:  this.encrypt(tokens.access_token),
        refreshTokenEncrypted: refreshTokenEncrypted,
        expiresAt,
        updatedAt: new Date(),
      },
    });

    this.logger.debug(
      `Tokens stored for user ${userId} (refresh_token ${tokens.refresh_token ? 'updated' : 'preserved'})`,
    );
  }

  /**
   * Retrieve and decrypt tokens. Returns null if none stored.
   */
  async getTokens(userId: string): Promise<{
    access_token:  string;
    refresh_token: string;
    expires_at:    Date;
  } | null> {
    const account = await this.prisma.teslaAccount.findUnique({ where: { userId } });
    if (!account) return null;

    const accessToken  = this.decrypt(account.accessTokenEncrypted);
    const refreshToken = this.decrypt(account.refreshTokenEncrypted);

    if (!refreshToken) {
      throw new Error('Stored Tesla refresh token is empty – user must relink Tesla account');
    }

    return {
      access_token:  accessToken,
      refresh_token: refreshToken,
      expires_at:    account.expiresAt,
    };
  }

  /**
   * Get a valid access token, auto-refreshing when within 5 min of expiry.
   *
   * Handles Tesla refresh responses that may or may not include refresh_token.
   */
  async getValidAccessToken(userId: string): Promise<string> {
    const tokens = await this.getTokens(userId);
    if (!tokens) throw new Error('No Tesla tokens found for user');

    const expirySoon = new Date(Date.now() + 5 * 60 * 1000);
    if (tokens.expires_at >= expirySoon) {
      return tokens.access_token; // still fresh
    }

    // ── Distributed lock: only one concurrent refresh per user ──────────────
    // Race condition: multiple services refreshing in parallel causes Tesla to
    // invalidate the token after the first use (each refresh invalidates the old
    // refresh_token immediately). Only the process that holds the lock performs
    // the actual refresh; others wait briefly and read the already-refreshed token.
    const lockKey = `tesla:refresh:lock:${userId}`;
    const acquired = await this.redis.setIfNotExists(lockKey, 30);

    if (!acquired) {
      // Another process is already refreshing — wait up to 3s then re-read from DB
      this.logger.debug(`Token refresh for ${userId} deferred (lock held by another process)`);
      await new Promise(r => setTimeout(r, 3000));
      const refreshed = await this.getTokens(userId);
      if (!refreshed) throw new Error('No Tesla tokens found for user');
      return refreshed.access_token;
    }

    try {
      this.logger.log(`Refreshing Tesla token for user ${userId}`);
      const fresh = await this.teslaFleet.refreshTokens(tokens.refresh_token);
      const account = await this.prisma.teslaAccount.findUnique({ where: { userId } });
      await this.storeTokens(userId, account?.email ?? '', fresh);
      // On successful refresh clear any auth-expired flag
      await this.redis.del(`${this.AUTH_EXPIRED_PREFIX}${userId}`);
      this.logger.debug(`Token refreshed for ${userId}${fresh.refresh_token ? ' (new refresh_token)' : ''}`);
      return fresh.access_token;
    } catch (error: any) {
      this.logger.error(`Failed to refresh token for user ${userId}: ${error.message}`);
      const status = error?.response?.status ?? error?.status;
      if (status === 401) {
        await this.redis.set(`${this.AUTH_EXPIRED_PREFIX}${userId}`, '1', 'EX', 7 * 24 * 3600);
        this.logger.warn(`Tesla auth expired for user ${userId} — re-authorization required`);
      }
      throw error;
    } finally {
      await this.redis.del(lockKey);
    }
  }

  async isAuthExpired(userId: string): Promise<boolean> {
    const val = await this.redis.get(`${this.AUTH_EXPIRED_PREFIX}${userId}`);
    return val === '1';
  }

  async clearAuthExpired(userId: string): Promise<void> {
    await this.redis.del(`${this.AUTH_EXPIRED_PREFIX}${userId}`);
  }

  /**
   * Get a valid access token scoped to a specific vehicle's linked Tesla account.
   *
   * Security model: verifies the vehicle's Tesla account belongs to userId before
   * returning a token. Prevents cross-account token access in multi-account setups.
   */
  async getTokenForVehicle(vehicleId: string, userId: string): Promise<string> {
    const link = await this.prisma.teslaVehicleLink.findUnique({
      where: { vehicleId },
      include: { teslaAccount: { select: { userId: true } } },
    });

    if (!link) {
      throw new Error(`No Tesla account linked to vehicle ${vehicleId}`);
    }

    // Ensure the linked account belongs to the requesting user
    if (link.teslaAccount.userId !== userId) {
      throw new Error('Vehicle does not belong to this user account');
    }

    return this.getValidAccessToken(link.teslaAccount.userId);
  }

  /**
   * Revoke and delete stored tokens.
   */
  async revokeTokens(userId: string): Promise<void> {
    this.logger.log(`Revoking Tesla tokens for user ${userId}`);
    await this.prisma.teslaAccount.delete({ where: { userId } }).catch(() => {});
  }

  /**
   * Helper: generate secure encryption keys for deployment.
   * Run once: TeslaOAuthService.generateKeys() and paste output into secrets/.env
   */
  static generateKeys(): { TESLA_ENCRYPTION_KEY: string } {
    return { TESLA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };
  }
}

