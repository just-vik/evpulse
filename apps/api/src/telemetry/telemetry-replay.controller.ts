import {
  Controller, Post, Param, Body, Request,
  UseGuards, BadRequestException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VehiclesService } from '../vehicles/vehicles.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelemetryPipelineService } from './telemetry-pipeline.service';
import { CreateTelemetryPointDto } from './dto/telemetry.dto';

interface ReplayBody {
  from: string; // ISO timestamp
  to:   string; // ISO timestamp
  dryRun?: boolean;
}

/**
 * Debug/replay endpoint.
 *
 * Takes raw events from `telemetry_raw` for a given time window
 * and re-runs them through the full pipeline.
 *
 * Use cases:
 *   - Re-detect trips/charging after a bug fix
 *   - Verify sanitizer behaviour against real data
 *   - Reproduce a reported issue exactly
 *
 * POST /telemetry/:vehicleId/replay
 * Body: { from: "2026-03-22T10:00:00Z", to: "2026-03-22T12:00:00Z" }
 */
@ApiTags('telemetry')
@Controller('telemetry')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class TelemetryReplayController {
  private readonly logger = new Logger(TelemetryReplayController.name);

  constructor(
    private readonly vehiclesService: VehiclesService,
    private readonly prisma: PrismaService,
    private readonly pipeline: TelemetryPipelineService,
  ) {}

  @Post(':vehicleId/replay')
  @ApiOperation({ summary: 'Replay raw telemetry through the pipeline (debug)' })
  async replay(
    @Param('vehicleId') vehicleId: string,
    @Body() body: ReplayBody,
    @Request() req: any,
  ) {
    await this.vehiclesService.findOne(vehicleId, req.user.id);

    const from = new Date(body.from);
    const to   = new Date(body.to);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from/to timestamps');
    }
    if (to.getTime() - from.getTime() > 24 * 60 * 60 * 1000) {
      throw new BadRequestException('Replay window must be ≤ 24 hours');
    }

    const rawEvents = await this.prisma.telemetryRaw.findMany({
      where: {
        vehicleId,
        receivedAt: { gte: from, lte: to },
      },
      orderBy: { receivedAt: 'asc' },
      select: { id: true, payload: true },
    });

    this.logger.log(
      `[Replay] ${vehicleId}: ${rawEvents.length} events from ${from.toISOString()} → ${to.toISOString()}` +
      (body.dryRun ? ' (dry run)' : ''),
    );

    if (body.dryRun) {
      return { vehicleId, from, to, eventCount: rawEvents.length, dryRun: true };
    }

    // Replay in batches of 50 to avoid memory pressure
    const BATCH = 50;
    let processed = 0;
    for (let i = 0; i < rawEvents.length; i += BATCH) {
      const batch = rawEvents.slice(i, i + BATCH).map((e) => e.payload as CreateTelemetryPointDto);
      await this.pipeline.processBatch(vehicleId, batch, 'replay');
      processed += batch.length;
    }

    return { vehicleId, from, to, eventCount: rawEvents.length, processed };
  }
}
