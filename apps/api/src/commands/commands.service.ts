import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CommandsService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Presets ──────────────────────────────────────────────────────────────

  async getPresets(userId: string, vehicleId?: string) {
    return this.prisma.commandPreset.findMany({
      where: {
        userId,
        ...(vehicleId ? { OR: [{ vehicleId }, { vehicleId: null }] } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async createPreset(userId: string, dto: {
    vehicleId?: string;
    name: string;
    command: string;
    params?: any;
    icon?: string;
    sortOrder?: number;
  }) {
    if (dto.vehicleId) {
      await this.assertVehicleOwnership(dto.vehicleId, userId);
    }
    return this.prisma.commandPreset.create({
      data: {
        userId,
        vehicleId: dto.vehicleId ?? null,
        name: dto.name,
        command: dto.command,
        params: dto.params ?? undefined,
        icon: dto.icon ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updatePreset(userId: string, presetId: string, dto: {
    name?: string;
    params?: any;
    icon?: string;
    sortOrder?: number;
  }) {
    const preset = await this.prisma.commandPreset.findUnique({ where: { id: presetId } });
    if (!preset) throw new NotFoundException('Preset not found');
    if (preset.userId !== userId) throw new ForbiddenException();
    return this.prisma.commandPreset.update({
      where: { id: presetId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.params !== undefined && { params: dto.params }),
        ...(dto.icon !== undefined && { icon: dto.icon }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
      },
    });
  }

  async deletePreset(userId: string, presetId: string) {
    const preset = await this.prisma.commandPreset.findUnique({ where: { id: presetId } });
    if (!preset) throw new NotFoundException('Preset not found');
    if (preset.userId !== userId) throw new ForbiddenException();
    await this.prisma.commandPreset.delete({ where: { id: presetId } });
    return { deleted: true };
  }

  // ── History ──────────────────────────────────────────────────────────────

  async recordHistory(data: {
    userId: string;
    vehicleId: string;
    presetId?: string;
    command: string;
    params?: any;
    status: 'success' | 'failed';
    result?: any;
    error?: string;
  }) {
    return this.prisma.commandHistory.create({
      data: {
        userId: data.userId,
        vehicleId: data.vehicleId,
        presetId: data.presetId ?? null,
        command: data.command,
        params: data.params ?? undefined,
        status: data.status,
        result: data.result ?? undefined,
        error: data.error ?? null,
      },
    });
  }

  async getHistory(userId: string, vehicleId: string, limit = 20) {
    return this.prisma.commandHistory.findMany({
      where: { userId, vehicleId },
      orderBy: { executedAt: 'desc' },
      take: Math.min(limit, 100),
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async assertVehicleOwnership(vehicleId: string, userId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: { userId: true },
    });
    if (!vehicle || vehicle.userId !== userId) throw new ForbiddenException('Vehicle not owned by user');
  }
}
