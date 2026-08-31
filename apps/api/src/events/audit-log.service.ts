import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditParams {
  userId?: string;
  type: string;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(params: AuditParams): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          userId:     params.userId     ?? null,
          type:       params.type,
          action:     params.action,
          targetType: params.targetType ?? null,
          targetId:   params.targetId   ?? null,
          ip:         params.ip         ?? null,
          userAgent:  params.userAgent  ?? null,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          metadata:   params.metadata != null ? (params.metadata as any) : undefined,
        },
      });
    } catch (e) {
      this.logger.error(
        `audit.record failed [${params.action}] user=${params.userId ?? 'anon'}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}
