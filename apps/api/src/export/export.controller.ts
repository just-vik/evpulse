import {
  Controller, Get, Query, Req, Res, UseGuards, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ExportService, ExportFormat } from './export.service';

const FORMATS = new Set<ExportFormat>(['csv', 'json', 'gpx']);
const MAX_RANGE_DAYS = 365;

function parseRange(startDate?: string, endDate?: string): { start: Date; end: Date } {
  const end   = endDate   ? new Date(endDate)   : new Date();
  const start = startDate ? new Date(startDate) : new Date(end.getTime() - 30 * 86_400_000);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new BadRequestException('Invalid date format');
  const diffDays = (end.getTime() - start.getTime()) / 86_400_000;
  if (diffDays > MAX_RANGE_DAYS) throw new BadRequestException(`Date range cannot exceed ${MAX_RANGE_DAYS} days`);
  return { start, end };
}

@ApiTags('export')
@Controller('export')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get('trips')
  @ApiOperation({ summary: 'Export trip history (CSV / GPX / JSON)' })
  @ApiQuery({ name: 'vehicleId', required: true,  type: String })
  @ApiQuery({ name: 'format',    required: false, type: String, enum: ['csv', 'json', 'gpx'] })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate',   required: false, type: String })
  async exportTrips(
    @Query('vehicleId') vehicleId: string,
    @Query('format')    format: string = 'csv',
    @Req() req: any,
    @Res() res: Response,
    @Query('startDate') startDate?: string,
    @Query('endDate')   endDate?: string,
  ) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');
    if (!FORMATS.has(format as ExportFormat)) throw new BadRequestException('format must be csv, json, or gpx');
    const { start, end } = parseRange(startDate, endDate);
    const result = await this.exportService.exportTrips(vehicleId, req.user.id, format as ExportFormat, start, end);
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(result.content);
  }

  @Get('charging')
  @ApiOperation({ summary: 'Export charging history (CSV / JSON)' })
  @ApiQuery({ name: 'vehicleId', required: true,  type: String })
  @ApiQuery({ name: 'format',    required: false, type: String, enum: ['csv', 'json'] })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate',   required: false, type: String })
  async exportCharging(
    @Query('vehicleId') vehicleId: string,
    @Query('format')    format: string = 'csv',
    @Req() req: any,
    @Res() res: Response,
    @Query('startDate') startDate?: string,
    @Query('endDate')   endDate?: string,
  ) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');
    const fmt = format === 'json' ? 'json' : 'csv';
    const { start, end } = parseRange(startDate, endDate);
    const result = await this.exportService.exportCharging(vehicleId, req.user.id, fmt, start, end);
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(result.content);
  }

  @Get('telemetry')
  @ApiOperation({ summary: 'Export raw telemetry (CSV / JSON), max 10k points per request' })
  @ApiQuery({ name: 'vehicleId', required: true,  type: String })
  @ApiQuery({ name: 'format',    required: false, type: String, enum: ['csv', 'json'] })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate',   required: false, type: String })
  async exportTelemetry(
    @Query('vehicleId') vehicleId: string,
    @Query('format')    format: string = 'csv',
    @Req() req: any,
    @Res() res: Response,
    @Query('startDate') startDate?: string,
    @Query('endDate')   endDate?: string,
  ) {
    if (!vehicleId) throw new BadRequestException('vehicleId is required');
    const fmt = format === 'json' ? 'json' : 'csv';
    const { start, end } = parseRange(startDate, endDate);
    const result = await this.exportService.exportTelemetry(vehicleId, req.user.id, fmt, start, end);
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(result.content);
  }
}
