import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ExportFormat = 'csv' | 'json' | 'gpx';
export type ExportEntity = 'trips' | 'charging' | 'telemetry';

function escapeCsv(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsv).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsv).join(','));
  return lines.join('\n');
}

function toGpx(trips: any[], pointsByTrip: Map<string, any[]>): string {
  const tracks = trips.map(trip => {
    const pts = pointsByTrip.get(trip.id) ?? [];
    const trkpts = pts.map(p => `    <trkpt lat="${p.latitude ?? 0}" lon="${p.longitude ?? 0}">
      <time>${new Date(p.timestamp).toISOString()}</time>
      <extensions><speed>${p.speed ?? ''}</speed><power>${p.power ?? ''}</power><soc>${p.soc ?? ''}</soc></extensions>
    </trkpt>`).join('\n');
    return `  <trk>
    <name>${escapeCsv(trip.startLocation ?? trip.startTime)}</name>
    <desc>Distance: ${trip.distanceKm?.toFixed(1) ?? '?'} km | Energy: ${trip.energyUsedKwh?.toFixed(2) ?? '?'} kWh</desc>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="EVPulse" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
${tracks}
</gpx>`;
}

@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  async exportTrips(
    vehicleId: string,
    userId: string,
    format: ExportFormat,
    startDate: Date,
    endDate: Date,
  ): Promise<{ content: string; filename: string; mimeType: string }> {
    await this.assertOwns(vehicleId, userId);

    const trips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        startTime: { gte: startDate, lte: endDate },
        endTime: { not: null },
      },
      orderBy: { startTime: 'desc' },
      take: 5000,
    });

    const dateTag = startDate.toISOString().slice(0, 10);

    if (format === 'json') {
      return {
        content: JSON.stringify(trips, null, 2),
        filename: `trips-${dateTag}.json`,
        mimeType: 'application/json',
      };
    }

    if (format === 'gpx') {
      const tripIds = trips.map(t => t.id);
      const allPoints = await this.prisma.tripPoint.findMany({
        where: { tripId: { in: tripIds }, latitude: { not: null }, longitude: { not: null } },
        orderBy: { timestamp: 'asc' },
        select: { tripId: true, timestamp: true, latitude: true, longitude: true, speed: true, power: true, soc: true },
      });
      const pointsByTrip = new Map<string, any[]>();
      for (const p of allPoints) {
        if (!pointsByTrip.has(p.tripId)) pointsByTrip.set(p.tripId, []);
        pointsByTrip.get(p.tripId)!.push(p);
      }
      return {
        content: toGpx(trips, pointsByTrip),
        filename: `trips-${dateTag}.gpx`,
        mimeType: 'application/gpx+xml',
      };
    }

    // CSV
    const headers = [
      'id', 'startTime', 'endTime', 'startLocation', 'endLocation',
      'distanceKm', 'energyUsedKwh', 'efficiencyWhkm',
      'startSoc', 'endSoc', 'costTotal', 'drivingScore', 'reliability',
    ];
    const rows = trips.map(t => [
      t.id, t.startTime.toISOString(), t.endTime?.toISOString() ?? '',
      t.startLocation ?? '', t.endLocation ?? '',
      t.distanceKm?.toFixed(3) ?? '', t.energyUsedKwh?.toFixed(3) ?? '',
      t.efficiencyWhkm?.toFixed(1) ?? '',
      t.startSoc?.toFixed(1) ?? '', t.endSoc?.toFixed(1) ?? '',
      t.costTotal?.toFixed(2) ?? '', t.drivingScore ?? '',
      t.reliability ?? '',
    ]);
    return {
      content: toCsv(headers, rows),
      filename: `trips-${dateTag}.csv`,
      mimeType: 'text/csv',
    };
  }

  async exportCharging(
    vehicleId: string,
    userId: string,
    format: ExportFormat,
    startDate: Date,
    endDate: Date,
  ): Promise<{ content: string; filename: string; mimeType: string }> {
    await this.assertOwns(vehicleId, userId);

    const sessions = await this.prisma.chargingSession.findMany({
      where: {
        vehicleId,
        startTime: { gte: startDate, lte: endDate },
      },
      orderBy: { startTime: 'desc' },
      take: 5000,
    });

    const dateTag = startDate.toISOString().slice(0, 10);

    if (format === 'json') {
      return {
        content: JSON.stringify(sessions, null, 2),
        filename: `charging-${dateTag}.json`,
        mimeType: 'application/json',
      };
    }

    const headers = [
      'id', 'startTime', 'endTime', 'location', 'chargerType',
      'startSoc', 'endSoc', 'energyAddedKwh', 'maxPowerKw',
      'costTotal', 'costPerKwh', 'currency', 'chargingEfficiency',
    ];
    const rows = sessions.map(s => [
      s.id, s.startTime.toISOString(), s.endTime?.toISOString() ?? '',
      s.location ?? '', s.chargerType ?? '',
      s.startSoc?.toFixed(1) ?? '', s.endSoc?.toFixed(1) ?? '',
      s.energyAddedKwh?.toFixed(3) ?? '', s.maxPowerKw?.toFixed(1) ?? '',
      s.costTotal?.toFixed(2) ?? '', s.costPerKwh?.toFixed(4) ?? '',
      s.currency ?? 'EUR', s.chargingEfficiency?.toFixed(3) ?? '',
    ]);
    return {
      content: toCsv(headers, rows),
      filename: `charging-${dateTag}.csv`,
      mimeType: 'text/csv',
    };
  }

  async exportTelemetry(
    vehicleId: string,
    userId: string,
    format: ExportFormat,
    startDate: Date,
    endDate: Date,
  ): Promise<{ content: string; filename: string; mimeType: string }> {
    await this.assertOwns(vehicleId, userId);

    const points = await this.prisma.telemetryPoint.findMany({
      where: {
        vehicleId,
        timestamp: { gte: startDate, lte: endDate },
      },
      orderBy: { timestamp: 'asc' },
      take: 10_000,
      select: {
        timestamp: true, soc: true, speed: true, power: true,
        batteryRangeKm: true, outsideTemp: true, insideTemp: true,
        batteryTemp: true, odometer: true, latitude: true, longitude: true,
        elevationM: true, heading: true,
      },
    });

    const dateTag = startDate.toISOString().slice(0, 10);

    if (format === 'json') {
      return {
        content: JSON.stringify(points, null, 2),
        filename: `telemetry-${dateTag}.json`,
        mimeType: 'application/json',
      };
    }

    const headers = [
      'timestamp', 'soc', 'speed', 'power', 'batteryRangeKm',
      'outsideTemp', 'insideTemp', 'batteryTemp', 'odometer',
      'latitude', 'longitude', 'elevationM', 'heading',
    ];
    const rows = points.map(p => [
      p.timestamp.toISOString(),
      p.soc?.toFixed(2) ?? '', p.speed?.toFixed(1) ?? '',
      p.power?.toFixed(2) ?? '', p.batteryRangeKm?.toFixed(1) ?? '',
      p.outsideTemp?.toFixed(1) ?? '', p.insideTemp?.toFixed(1) ?? '',
      p.batteryTemp?.toFixed(1) ?? '', p.odometer?.toFixed(1) ?? '',
      p.latitude ?? '', p.longitude ?? '',
      p.elevationM?.toFixed(1) ?? '', p.heading?.toFixed(0) ?? '',
    ]);
    return {
      content: toCsv(headers, rows),
      filename: `telemetry-${dateTag}.csv`,
      mimeType: 'text/csv',
    };
  }

  private async assertOwns(vehicleId: string, userId: string): Promise<void> {
    const v = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, userId },
      select: { id: true },
    });
    if (!v) throw new ForbiddenException('Vehicle not found or not owned by you');
  }
}
