import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AiService, type InsightContext, type AIInsight } from './ai.service';
import { AIGuardService } from './ai-guard.service';
import { AIExecutorService } from './ai-executor.service';

export type AutoMode = 'off' | 'suggest' | 'auto';

@Injectable()
export class AIAgentService {
  private readonly logger = new Logger(AIAgentService.name);

  constructor(
    private readonly ai: AiService,
    private readonly guard: AIGuardService,
    private readonly executor: AIExecutorService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Check if an insight command has been recently rejected by this user.
   * If rejected in the last 7 days, auto-execution is disabled for safety.
   */
  private async isRecentlyRejected(vehicleId: string, title: string): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT COUNT(*) AS cnt
        FROM "ai_insight_logs"
        WHERE "vehicleId" = ${vehicleId}
          AND "title" = ${title}
          AND "accepted" = false
          AND "createdAt" > NOW() - INTERVAL '7 days'
      `;
      return Number(rows[0]?.cnt ?? 0) > 0;
    } catch {
      return false; // If check fails, allow execution
    }
  }

  /**
   * Process vehicle context:
   * 1. Generate AI insights (with scoring + suppression applied)
   * 2. In 'auto' mode — execute safe, high-priority commands
   *    but SKIP commands the user has recently rejected
   * 3. Return insights + list of executed/skipped commands with reasons
   */
  async process(
    context: InsightContext,
    mode: AutoMode,
  ): Promise<{
    insights: AIInsight[];
    executed: string[];
    skipped: Array<{ command: string; reason: string }>;
  }> {
    const insights = await this.ai.generateInsights(context);
    const executed: string[] = [];
    const skipped: Array<{ command: string; reason: string }> = [];

    if (mode !== 'auto' || !context.userId) {
      return { insights, executed, skipped };
    }

    for (const insight of insights) {
      if (!insight.action || insight.action.type !== 'command') continue;
      if (insight.priority < 80) continue;

      const command = (insight.action as any).command as string;

      // Guard check (vehicle state safety)
      if (!this.guard.canExecute(command, context)) {
        skipped.push({ command, reason: 'guard blocked' });
        continue;
      }

      // Feedback check — respect user's past rejections
      const rejected = await this.isRecentlyRejected(context.vehicleId, insight.title);
      if (rejected) {
        this.logger.debug(
          `[Agent] Skipping auto-execute of "${command}" — insight "${insight.title}" was recently rejected`,
        );
        skipped.push({ command, reason: 'recently rejected by user' });
        continue;
      }

      const result = await this.executor.execute(
        context.vehicleId,
        context.userId,
        command,
        'auto',
      );

      if (result.executed) {
        executed.push(command);
        this.logger.log(`[Agent] Auto-executed: ${command} (${insight.title})`);
      } else {
        skipped.push({ command, reason: result.reason ?? 'executor blocked' });
      }
    }

    return { insights, executed, skipped };
  }

  getRecentActions(vehicleId: string) {
    return this.executor.getRecentActions(vehicleId);
  }
}
