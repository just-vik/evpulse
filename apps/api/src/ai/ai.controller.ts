import { Body, Controller, Get, Param, Post, Request, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiEntitlementGuard } from './ai-entitlement.guard';
import { RequireEntitlement } from './ai-entitlement.decorator';
import { AiService, InsightContext } from './ai.service';
import { AIAgentService } from './ai-agent.service';
import { AIExecutorService } from './ai-executor.service';
import { AiContextBuilder } from './ai-context.builder';
import { InsightsBatchService } from './insights-batch.service';
import { VehiclesService } from '../vehicles/vehicles.service';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';

@ApiTags('ai')
@Controller('ai')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AiController {
  constructor(
    private readonly ai: AiService,
    private readonly agent: AIAgentService,
    private readonly executor: AIExecutorService,
    private readonly contextBuilder: AiContextBuilder,
    private readonly insightsBatch: InsightsBatchService,
    private readonly vehicles: VehiclesService,
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  /**
   * Generate AI insights from vehicle context.
   * userId is injected from JWT — never trusted from request body.
   * POST /api/v1/ai/insights
   */
  @Post('insights')
  @UseGuards(AiEntitlementGuard)
  @RequireEntitlement('aiInsights')
  @ApiOperation({ summary: 'Generate AI insights from vehicle telemetry context' })
  async getInsights(
    @Body() context: Omit<InsightContext, 'userId'>,
    @Request() req: any,
  ) {
    await this.vehicles.assertOwnership(context.vehicleId, req.user.id);

    // Resolve language: body > user settings DB
    let language = (context as any).language as string | undefined;
    if (!language) {
      const settings = await this.prisma.$queryRaw<Array<{ language: string | null }>>`
        SELECT language FROM "user_settings" WHERE "userId" = ${req.user.id} LIMIT 1
      `;
      language = settings[0]?.language ?? 'en';
    }

    return this.ai.generateInsights({ ...context, userId: req.user.id, language });
  }

  /**
   * Return nightly pre-computed insights (cached from last 08:00 UTC run).
   * Fast — no Groq call needed. Returns null if not yet generated today.
   * GET /api/v1/ai/insights/:vehicleId/nightly
   */
  @Get('insights/:vehicleId/nightly')
  @UseGuards(AiEntitlementGuard)
  @RequireEntitlement('aiInsights')
  @ApiOperation({ summary: 'Get nightly pre-computed AI insights (cached)' })
  async getNightlyInsights(@Param('vehicleId') vehicleId: string, @Request() req: any) {
    await this.vehicles.assertOwnership(vehicleId, req.user.id);
    return this.insightsBatch.getNightlyInsights(vehicleId);
  }

  /**
   * Conversational AI — ask anything about the vehicle.
   * Also returns parsed intent for command suggestions.
   * POST /api/v1/ai/chat
   */
  @Post('chat')
  @ApiOperation({ summary: 'AI chat — ask about vehicle, efficiency, battery, etc.' })
  async chat(
    @Body() body: { message: string; vehicleId?: string; context?: Partial<InsightContext> },
    @Request() req: any,
  ) {
    const vehicleId = body.vehicleId ?? body.context?.vehicleId;
    if (vehicleId) {
      await this.vehicles.assertOwnership(vehicleId, req.user.id);
    }
    const ent = await this.billing.getEntitlements(req.user.id);
    const [dbContext, ragContext] = await Promise.all([
      vehicleId ? this.ai.buildContextForVehicle(vehicleId) : Promise.resolve({}),
      // RAG semantic search only for users with ragEnabled entitlement
      vehicleId && ent.ragEnabled
        ? this.contextBuilder.buildChatContext(vehicleId, body.message)
        : Promise.resolve({ historicalSummaries: [] }),
    ]);
    const mergedContext = { ...dbContext, ...ragContext, ...body.context, vehicleId, userId: req.user.id };
    return this.ai.chat(body.message, mergedContext);
  }

  /**
   * Parse a user message into a structured intent without executing it.
   * POST /api/v1/ai/intent
   */
  @Post('intent')
  @ApiOperation({ summary: 'Parse a natural language message into a command intent' })
  async parseIntent(@Body() body: { message: string }) {
    return this.ai.parseIntent(body.message);
  }

  /**
   * Chat with immediate intent execution if confidence >= 0.8.
   * POST /api/v1/ai/chat/execute
   */
  @Post('chat/execute')
  @ApiOperation({ summary: 'Chat + auto-execute if intent is high confidence' })
  async chatAndExecute(
    @Body() body: {
      message: string;
      vehicleId: string;
      context?: Partial<InsightContext>;
    },
    @Request() req: any,
  ) {
    await this.vehicles.assertOwnership(body.vehicleId, req.user.id);

    const chatResult = await this.ai.chat(body.message, {
      ...body.context,
      vehicleId: body.vehicleId,
      userId: req.user.id,
    });

    let execution: { executed: boolean; reason?: string } | null = null;
    const intent = chatResult.intent;

    if (intent?.type === 'command' && intent.command && intent.confidence >= 0.8) {
      execution = await this.executor.execute(
        body.vehicleId,
        req.user.id,
        intent.command,
        'chat',
      );
    }

    return { ...chatResult, execution };
  }

  /**
   * Run AI agent in suggest or auto mode.
   * POST /api/v1/ai/agent
   */
  @Post('agent')
  @UseGuards(AiEntitlementGuard)
  @RequireEntitlement('aiAgent')
  @ApiOperation({ summary: 'Run AI agent — generate insights and optionally auto-execute' })
  async runAgent(
    @Body() body: { context: Omit<InsightContext, 'userId'>; mode?: 'off' | 'suggest' | 'auto' },
    @Request() req: any,
  ) {
    await this.vehicles.assertOwnership(body.context.vehicleId, req.user.id);
    const ctx: InsightContext = { ...body.context, userId: req.user.id };
    return this.agent.process(ctx, body.mode ?? 'suggest');
  }

  /**
   * Record user feedback on an insight.
   * Also triggers suppression if accepted/rejected.
   * POST /api/v1/ai/feedback
   */
  @Post('feedback')
  @ApiOperation({ summary: 'Record user feedback (accepted/rejected) on an AI insight' })
  async recordFeedback(
    @Body() body: {
      vehicleId: string;
      insightId: string;
      title: string;
      severity: string;
      accepted: boolean;
    },
    @Request() req: any,
  ) {
    await this.vehicles.assertOwnership(body.vehicleId, req.user.id);

    await this.prisma.$executeRaw`
      INSERT INTO "ai_insight_logs" ("id", "vehicleId", "insightId", "title", "severity", "createdAt", "accepted")
      VALUES (gen_random_uuid()::text, ${body.vehicleId}, ${body.insightId}, ${body.title}, ${body.severity}, NOW(), ${body.accepted})
      ON CONFLICT DO NOTHING
    `;

    // Suppress seen insights to prevent flooding (danger insights are never suppressed)
    await this.ai.suppressInsight(body.vehicleId, body.insightId, body.severity);

    return { ok: true };
  }

  /**
   * AI activity log for a vehicle.
   * GET /api/v1/ai/activity/:vehicleId
   */
  @Get('activity/:vehicleId')
  @ApiOperation({ summary: 'Get recent AI actions for a vehicle' })
  async getActivity(
    @Param('vehicleId') vehicleId: string,
    @Request() req: any,
  ) {
    await this.vehicles.assertOwnership(vehicleId, req.user.id);
    return this.executor.getRecentActions(vehicleId);
  }

  /**
   * Get user AI preferences (autoMode).
   * GET /api/v1/ai/preferences
   */
  @Get('preferences')
  @ApiOperation({ summary: 'Get AI preferences for current user' })
  async getPreferences(@Request() req: any) {
    const prefs = await this.prisma.$queryRaw<Array<{ autoMode: string; maxAutoActionsPerHour: number }>>`
      SELECT "autoMode", "maxAutoActionsPerHour"
      FROM "ai_preferences"
      WHERE "userId" = ${req.user.id}
      LIMIT 1
    `;
    return prefs[0] ?? { autoMode: 'suggest', maxAutoActionsPerHour: 3 };
  }

  /**
   * Update AI preferences.
   * POST /api/v1/ai/preferences
   */
  @Post('preferences')
  @ApiOperation({ summary: 'Update AI preferences' })
  async setPreferences(
    @Body() body: { autoMode?: string; maxAutoActionsPerHour?: number },
    @Request() req: any,
  ) {
    const mode = body.autoMode ?? 'suggest';
    const limit = body.maxAutoActionsPerHour ?? 3;

    await this.prisma.$executeRaw`
      INSERT INTO "ai_preferences" ("id", "userId", "autoMode", "maxAutoActionsPerHour", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${req.user.id}, ${mode}, ${limit}, NOW(), NOW())
      ON CONFLICT ("userId") DO UPDATE SET "autoMode" = ${mode}, "maxAutoActionsPerHour" = ${limit}, "updatedAt" = NOW()
    `;
    return { autoMode: mode, maxAutoActionsPerHour: limit };
  }
}
