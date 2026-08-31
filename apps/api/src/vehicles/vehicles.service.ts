import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class VehiclesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lightweight ownership check — throws ForbiddenException if vehicleId ≠ userId.
   * Use this in controllers instead of a full findOne when you just need access control.
   */
  async assertOwnership(vehicleId: string, userId: string): Promise<void> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { userId: true },
    });
    if (!vehicle) throw new NotFoundException('Vehicle not found');
    if (vehicle.userId !== userId) throw new ForbiddenException('Access denied');
  }

  async findAllForUser(userId: string) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { userId },
      include: {
        vehicleSpec: true,
        settings: true,
        vehicleState: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Fallback odometer from telemetry_points when vehicle_states.odometer is null
    const needOdometer = vehicles
      .filter(v => v.vehicleState?.odometer == null)
      .map(v => v.id);

    const odometerMap = new Map<string, number>();
    if (needOdometer.length > 0) {
      const latest = await Promise.all(
        needOdometer.map(id =>
          this.prisma.telemetryPoint.findFirst({
            where: { vehicleId: id, odometer: { not: null } },
            orderBy: { timestamp: 'desc' },
            select: { vehicleId: true, odometer: true },
          }),
        ),
      );
      for (const row of latest) {
        if (row?.odometer != null) odometerMap.set(row.vehicleId, row.odometer);
      }
    }

    return vehicles.map(vehicle => {
      const resp = this.formatVehicleResponse(vehicle);
      if (resp.odometer == null && odometerMap.has(vehicle.id)) {
        resp.odometer = odometerMap.get(vehicle.id);
      }
      return resp;
    });
  }

  async findOne(id: string, userId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({ 
      where: { id },
      include: {
        vehicleSpec: true,
        settings: true,
        vehicleState: true,
      }
    });
    if (!vehicle) throw new NotFoundException(`Vehicle #${id} not found`);
    if (vehicle.userId !== userId) throw new ForbiddenException('Access denied');
    return this.formatVehicleResponse(vehicle);
  }

  /**
   * Detailed vehicle spec for UI card: joins Vehicle + VehicleSpec
   * and exposes battery and drivetrain information.
   */
  async getSpec(id: string, userId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
      include: {
        vehicleSpec: true,
        settings: true,
      },
    });
    if (!vehicle) throw new NotFoundException(`Vehicle #${id} not found`);
    if (vehicle.userId !== userId) throw new ForbiddenException('Access denied');

    const spec = vehicle.vehicleSpec;

    const modelCode = spec?.modelCode ?? null;
    const yr        = vehicle.year ?? null;

    // Derive drivetrain from spec modelCode first (most accurate), then from trim
    const driveType = modelCode?.includes('rwd') ? 'RWD'
      : modelCode?.includes('awd') || modelCode?.includes('performance') || modelCode?.includes('plaid') || modelCode?.includes('beast') ? 'AWD'
      : vehicle.trim?.includes('RWD') ? 'RWD'
      : vehicle.trim?.includes('AWD') ? 'AWD'
      : null;

    // Generation label from spec DB (set in seed/service) — never computed from year alone
    // to avoid false positives on border-year vehicles (e.g. pre-Juniper 2025 MY)
    const generation: string | null = (spec as any)?.generation ?? null;

    // Charging chemistry and recommendation
    const cellChemistry = (spec as any)?.cellChemistry ?? null;
    const chargeRecommendation: string | null =
      cellChemistry === 'LFP' ? 'charge_to_100'
      : cellChemistry === 'NMC' ? 'charge_to_80'
      : null;

    return {
      vehicleId: vehicle.id,
      vin: vehicle.vin,
      model: vehicle.model,
      displayName:
        vehicle.settings?.displayName ||
        spec?.displayName ||
        `${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ''}`,
      trim: vehicle.trim,
      year: yr,
      region: spec?.region ?? null,
      modelCode,
      generation,
      // Battery
      batteryNominalKwh:
        spec?.batteryNominalKwh ?? vehicle.batteryCapacityNominal,
      batteryUsableKwh:
        spec?.batteryUsableKwh ?? vehicle.batteryCapacityUsable,
      batteryDetectedKwh: vehicle.batteryCapacityDetected ?? null,
      peakChargingKw:  spec?.peakChargingKw ?? null,
      // Drivetrain & chemistry
      driveType,
      cellChemistry,
      chargeRecommendation,
      wltpKm: spec?.rangeWltp ?? null,
    };
  }

  /**
   * Decode model year from VIN position 10 (index 9).
   * Standard WMI encoding: A=2010, B=2011 … S=2025, T=2026, …
   */
  private yearFromVin(vin: string | null): number | null {
    if (!vin || vin.length < 10) return null;
    const map: Record<string, number> = {
      A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015,
      G: 2016, H: 2017, J: 2018, K: 2019, L: 2020, M: 2021,
      N: 2022, P: 2023, R: 2024, S: 2025, T: 2026, V: 2027,
    };
    return map[vin[9].toUpperCase()] ?? null;
  }

  /**
   * Format vehicle database record to API response format
   */
  private formatVehicleResponse(vehicle: any) {
    return {
      id: vehicle.id,
      userId: vehicle.userId,
      teslaId: vehicle.teslaId,
      vin: vehicle.vin,
      model: vehicle.model,
      trim: vehicle.trim,
      year: vehicle.year ?? this.yearFromVin(vehicle.vin),
      status: vehicle.status,
      displayName: vehicle.settings?.displayName || `${vehicle.model}${vehicle.trim ? ` ${vehicle.trim}` : ''}`,
      batteryCapacityNominal: vehicle.batteryCapacityNominal,
      batteryCapacityUsable: vehicle.batteryCapacityUsable,
      // Current state
      vehicleState: vehicle.vehicleState?.state || 'offline',
      chargingState: vehicle.vehicleState?.chargingState || null,
      locked: vehicle.vehicleState?.locked ?? true,
      odometer: vehicle.vehicleState?.odometer,
      lastUpdate: vehicle.vehicleState?.lastUpdate,
      // Self-driving / FSD stats (Tesla Dec 2025+)
      selfDrivingKmTotal: vehicle.selfDrivingKmTotal ?? null,
      odometerKmSinceReset: vehicle.odometerKmSinceReset ?? null,
      selfDrivingPct: vehicle.selfDrivingKmTotal && vehicle.odometerKmSinceReset
        ? Math.round((vehicle.selfDrivingKmTotal / vehicle.odometerKmSinceReset) * 1000) / 10
        : null,
      createdAt: vehicle.createdAt,
      updatedAt: vehicle.updatedAt,
    };
  }

  async create(userId: string, data: {
    teslaId?: string;
    vin: string;
    model: string;
    trim?: string;
    year?: number;
    batteryCapacityNominal?: number;
    batteryCapacityUsable?: number;
  }) {
    const created = await this.prisma.vehicle.create({
      data: {
        userId,
        vin: data.vin,
        model: data.model,
        trim: data.trim,
        year: data.year,
        teslaId: data.teslaId,
        batteryCapacityNominal: data.batteryCapacityNominal ?? 75.0,
        batteryCapacityUsable: data.batteryCapacityUsable ?? 72.0,
      },
      include: {
        vehicleSpec: true,
        settings: true,
        vehicleState: true,
      }
    });

    // Initialize vehicle state if not exists
    if (!created.vehicleState) {
      await this.prisma.vehicleState.create({
        data: {
          vehicleId: created.id,
          timestamp: new Date(),
          state: 'offline',
        }
      });
    }

    // Always ensure VehicleSettings exist with sane defaults.
    // Without this record: isAtHomeLocation returns false, cost calculation uses
    // hardcoded fallbacks, and charging type detection can't distinguish home/public.
    if (!created.settings) {
      await this.prisma.vehicleSettings.create({
        data: {
          vehicleId: created.id,
          // Tariff defaults — user should update via settings UI
          homeChargingRate:   0.35,  // €/kWh
          superchargerRate:   0.49,  // €/kWh (peak)
          thirdPartyRate:     0.55,  // €/kWh
          // Home location defaults to null — user must set via settings UI
          homeLatitude:  null,
          homeLongitude: null,
        },
      });
    }

    return this.formatVehicleResponse(created);
  }

  async update(id: string, userId: string, data: Partial<{
    trim: string;
    year: number;
    batteryCapacityNominal: number;
    batteryCapacityUsable: number;
    status: string;
  }>) {
    await this.findOne(id, userId);
    const updated = await this.prisma.vehicle.update({
      where: { id },
      data,
      include: {
        vehicleSpec: true,
        settings: true,
        vehicleState: true,
      }
    });
    return this.formatVehicleResponse(updated);
  }

  async remove(id: string, userId: string) {
    const vehicle = await this.findOne(id, userId);
    await this.prisma.vehicle.delete({ where: { id } });
    return vehicle;
  }
}
