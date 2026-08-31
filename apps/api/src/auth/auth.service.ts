import { Injectable, UnauthorizedException, ConflictException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../events/audit-log.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

function detectDevice(ua: string = ''): string {
  const s = ua.toLowerCase();
  if (/mobile|android|iphone/.test(s)) return 'mobile';
  if (/tablet|ipad/.test(s)) return 'tablet';
  if (/bot|crawler|spider/.test(s)) return 'bot';
  return 'desktop';
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async register(registerDto: RegisterDto) {
    const existingUser = await this.usersService.findByEmail(registerDto.email);
    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(registerDto.password, 12);
    const user = await this.usersService.create({
      ...registerDto,
      password: hashedPassword,
    });

    const tokens = await this.generateTokens(user.id, user.email);
    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  async login(loginDto: LoginDto, meta?: { ip?: string; userAgent?: string }) {
    const user = await this.validateUser(loginDto.email, loginDto.password);
    if (!user) {
      try {
        await this.prisma.loginEvent?.create({
          data: {
            email: loginDto.email,
            ip: meta?.ip ?? null,
            userAgent: meta?.userAgent ?? null,
            device: detectDevice(meta?.userAgent),
            success: false,
            failReason: 'invalid_credentials',
          },
        });
      } catch (e) {
        this.logger.error(`Failed to record failed login event: ${e instanceof Error ? e.message : String(e)}`);
      }
      await this.auditLog.record({
        type: 'auth',
        action: 'login.failed',
        ip: meta?.ip,
        userAgent: meta?.userAgent,
        metadata: { email: loginDto.email, reason: 'invalid_credentials' },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(user.id, user.email);

    try {
      await this.prisma.loginEvent?.create({
        data: {
          userId: user.id,
          email: user.email,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          device: detectDevice(meta?.userAgent),
          success: true,
        },
      });
    } catch (e) {
      this.logger.error(`Failed to record login event for user ${user.id}: ${e instanceof Error ? e.message : String(e)}`);
    }

    await this.auditLog.record({
      userId: user.id,
      type: 'auth',
      action: 'login.success',
      ip: meta?.ip,
      userAgent: meta?.userAgent,
    });

    return {
      user: this.sanitizeUser(user),
      ...tokens,
    };
  }

  async getLoginHistory(userId: string, limit = 20) {
    return this.prisma.loginEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 100),
      select: {
        id: true,
        ip: true,
        userAgent: true,
        device: true,
        success: true,
        failReason: true,
        createdAt: true,
      },
    });
  }

  async validateUser(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);
    if (!user) return null;

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) return null;

    return user;
  }

  async generateTokens(userId: string, email: string) {
    const payload = { sub: userId, email };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('app.jwt.refreshSecret'),
        expiresIn: (this.configService.get<string>('app.jwt.refreshExpiresIn') || '30d') as any,
      }),
    ]);

    // persist a *hashed* copy of the refresh token so that we can revoke it later
    try {
      const hashed = await bcrypt.hash(refreshToken, 12);
      await this.usersService.setRefreshToken(userId, hashed);
    } catch (e) {
      // log and continue; failure to persist should not block login
      this.logger.warn(`could not save refresh token for user ${userId}: ${e.message}`);
    }

    return { accessToken, refreshToken };
  }

  async refreshTokens(userId: string, refreshToken: string) {
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: this.configService.get<string>('app.jwt.refreshSecret'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Prevent privilege escalation: body userId must match token subject.
    if (!payload?.sub || payload.sub !== userId) {
      throw new UnauthorizedException('Invalid refresh token subject');
    }

    const user = await this.usersService.findById(userId);
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // Fail closed: refresh requires a stored hashed token for revocation semantics.
    if (!user.refreshToken) {
      throw new UnauthorizedException('Refresh session not found');
    }

    const isMatch = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return this.generateTokens(user.id, user.email);
  }

  private sanitizeUser(user: any) {
    const { password, ...sanitized } = user;
    return sanitized;
  }


  async logout(userId: string) {
    // tokens are stateless JWTs, but we may have stored a hash of the
    // refresh token in the database; clear it so it cannot be used again.
    try {
      await this.usersService.setRefreshToken(userId, null);
    } catch {
      // if the field or table doesn't exist, ignore silently
    }
  }
}
