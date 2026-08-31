import { Injectable, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    refreshToken?: string | null;
  }) {
    return this.prisma.user.create({
      data,
    });
  }

  async findAll() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async findByEmail(email: string) {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async update(
    id: string,
    data: Partial<{
      email: string;
      firstName: string;
      lastName: string;
      refreshToken?: string | null;
    }>,
  ) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException(`User #${id} not found`);

    return this.prisma.user.update({
      where: { id },
      data,
    });
  }

  async remove(id: string) {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException(`User #${id} not found`);

    return this.prisma.user.delete({ where: { id } });
  }

  /**
   * Full GDPR-compliant account deletion:
   * 1. Revokes Tesla OAuth tokens via the provided callback
   * 2. Hard-deletes user + all cascaded data (vehicles, telemetry, trips, etc.)
   * Called from UsersController with Tesla revoke injected to avoid circular dep.
   */
  async deleteAccount(
    id: string,
    revokeTokens: (userId: string) => Promise<void>,
  ): Promise<{ deleted: true }> {
    const user = await this.findById(id);
    if (!user) throw new NotFoundException('User not found');

    // 1. Revoke Tesla OAuth — must happen before DB row is deleted
    await revokeTokens(id).catch(() => {
      // Non-fatal: proceed even if Tesla API is unreachable.
      // Tokens are encrypted in DB and will be cascade-deleted anyway.
    });

    // 2. Null-out refresh token immediately (invalidates all sessions)
    await this.prisma.user.update({
      where: { id },
      data: { refreshToken: null },
    }).catch(() => {});

    // 3. Hard delete — all related rows cascade (see schema onDelete: Cascade)
    await this.prisma.user.delete({ where: { id } });

    return { deleted: true };
  }

  /**
   * Record explicit GDPR consent for a user.
   * Stores policy version, timestamp, and masked IP for audit trail.
   */
  async recordConsent(
    userId: string,
    opts: {
      policyVersion: string;
      ipAddress?: string;
      userAgent?: string;
      channel?: string;
    },
  ): Promise<{ id: string; consentedAt: Date }> {
    // Mask last IP octet for GDPR compliance (e.g. 192.168.1.123 → 192.168.1.0)
    const maskedIp = opts.ipAddress
      ? opts.ipAddress.replace(/\.\d+$/, '.0')
      : null;

    const record = await (this.prisma as any).userConsent.create({
      data: {
        id: randomBytes(16).toString('hex'),
        userId,
        policyVersion: opts.policyVersion,
        ipAddress: maskedIp,
        userAgent: opts.userAgent ?? null,
        channel: opts.channel ?? 'app',
      },
      select: { id: true, consentedAt: true },
    });

    return record;
  }

  /**
   * Returns latest consent record for a user (if any).
   */
  async getLatestConsent(userId: string): Promise<{ policyVersion: string; consentedAt: Date } | null> {
    const record = await (this.prisma as any).userConsent.findFirst({
      where: { userId },
      orderBy: { consentedAt: 'desc' },
      select: { policyVersion: true, consentedAt: true },
    });
    return record ?? null;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

    if (newPassword.length < 8) throw new BadRequestException('New password must be at least 8 characters');

    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({ where: { id: userId }, data: { password: hashed } });
  }

  // helper used by auth service when issuing / revoking tokens
  async setRefreshToken(userId: string, token: string | null) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: token },
    });
  }
}
