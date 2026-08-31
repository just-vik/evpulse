import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateVehicleSettingsDto } from './dto/update-vehicle-settings.dto';

export interface VehicleSettingsDto {
  vehicleId: string;
  homeChargingRate: number;
  superchargerRate: number;
  thirdPartyRate: number;
  defaultChargeLimit: number;
  lowBatteryThreshold: number;
  updatedAt: string;
}

const DEFAULTS: Omit<VehicleSettingsDto, 'vehicleId' | 'updatedAt'> = {
  homeChargingRate: 0.35,
  superchargerRate: 0.49,
  thirdPartyRate: 0.45,
  defaultChargeLimit: 80,
  lowBatteryThreshold: 20,
};

@Injectable()
export class VehicleSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private ensureOwnership(vehicle: { id: string; userId: string }, userId: string) {
    if (!vehicle) {
      throw new NotFoundException('Vehicle not found');
    }
    if (vehicle.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }
  }

  async getSettings(vehicleId: string, userId: string): Promise<VehicleSettingsDto> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, userId: true },
    });
    this.ensureOwnership(vehicle as any, userId);

    const row = await this.prisma.vehicleSettings.findUnique({
      where: { vehicleId },
    });

    return {
      vehicleId,
      homeChargingRate: row?.homeChargingRate ?? row?.chargingCost ?? DEFAULTS.homeChargingRate,
      superchargerRate: row?.superchargerRate ?? DEFAULTS.superchargerRate,
      thirdPartyRate: row?.thirdPartyRate ?? DEFAULTS.thirdPartyRate,
      defaultChargeLimit: row?.defaultChargeLimit ?? DEFAULTS.defaultChargeLimit,
      lowBatteryThreshold: row?.lowBatteryThreshold ?? DEFAULTS.lowBatteryThreshold,
      updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
    };
  }

  async updateSettings(
    vehicleId: string,
    userId: string,
    dto: UpdateVehicleSettingsDto,
  ): Promise<VehicleSettingsDto> {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { id: true, userId: true },
    });
    this.ensureOwnership(vehicle as any, userId);

    const existing = await this.prisma.vehicleSettings.findUnique({
      where: { vehicleId },
    });

    const homeRate =
      dto.homeChargingRate ??
      existing?.homeChargingRate ??
      existing?.chargingCost ??
      DEFAULTS.homeChargingRate;

    const row = await this.prisma.vehicleSettings.upsert({
      where: { vehicleId },
      create: {
        vehicleId,
        displayName: existing?.displayName,
        homeLatitude: existing?.homeLatitude,
        homeLongitude: existing?.homeLongitude,
        timezone: existing?.timezone ?? 'UTC',
        chargingCost: homeRate,
        homeChargingRate: homeRate,
        superchargerRate: dto.superchargerRate ?? existing?.superchargerRate ?? DEFAULTS.superchargerRate,
        thirdPartyRate: dto.thirdPartyRate ?? existing?.thirdPartyRate ?? DEFAULTS.thirdPartyRate,
        defaultChargeLimit:
          dto.defaultChargeLimit ?? existing?.defaultChargeLimit ?? DEFAULTS.defaultChargeLimit,
        lowBatteryThreshold:
          dto.lowBatteryThreshold ?? existing?.lowBatteryThreshold ?? DEFAULTS.lowBatteryThreshold,
      },
      update: {
        // keep legacy chargingCost in sync with home rate
        chargingCost: homeRate,
        homeChargingRate: dto.homeChargingRate ?? existing?.homeChargingRate ?? homeRate,
        superchargerRate: dto.superchargerRate ?? undefined,
        thirdPartyRate: dto.thirdPartyRate ?? undefined,
        defaultChargeLimit: dto.defaultChargeLimit ?? undefined,
        lowBatteryThreshold: dto.lowBatteryThreshold ?? undefined,
      },
    });

    return {
      vehicleId,
      homeChargingRate: row.homeChargingRate,
      superchargerRate: row.superchargerRate,
      thirdPartyRate: row.thirdPartyRate,
      defaultChargeLimit: row.defaultChargeLimit,
      lowBatteryThreshold: row.lowBatteryThreshold,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

