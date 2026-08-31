import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateAutomationDto {
  vehicleId?:   string | null;
  name:         string;
  description?: string;
  enabled?:     boolean;
  conditions:   unknown[];
  actions:      unknown[];
  schedule:     Record<string, unknown>;
}

export type UpdateAutomationDto = Partial<CreateAutomationDto>;

@Injectable()
export class AutomationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(userId: string) {
    return this.prisma.automation.findMany({
      where:   { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string) {
    const row = await this.prisma.automation.findUnique({ where: { id } });
    if (!row)                throw new NotFoundException(`Automation ${id} not found`);
    if (row.userId !== userId) throw new ForbiddenException();
    return row;
  }

  async create(userId: string, dto: CreateAutomationDto) {
    return this.prisma.automation.create({
      data: {
        userId,
        vehicleId:   dto.vehicleId   ?? null,
        name:        dto.name,
        description: dto.description ?? null,
        enabled:     dto.enabled     ?? true,
        conditions:  dto.conditions  as any,
        actions:     dto.actions     as any,
        schedule:    dto.schedule    as any,
      },
    });
  }

  async update(id: string, userId: string, dto: UpdateAutomationDto) {
    await this.findOne(id, userId); // ownership check

    return this.prisma.automation.update({
      where: { id },
      data: {
        ...(dto.vehicleId   !== undefined && { vehicleId:   dto.vehicleId   ?? null }),
        ...(dto.name        !== undefined && { name:        dto.name }),
        ...(dto.description !== undefined && { description: dto.description ?? null }),
        ...(dto.enabled     !== undefined && { enabled:     dto.enabled }),
        ...(dto.conditions  !== undefined && { conditions:  dto.conditions  as any }),
        ...(dto.actions     !== undefined && { actions:     dto.actions     as any }),
        ...(dto.schedule    !== undefined && { schedule:    dto.schedule    as any }),
      },
    });
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId); // ownership check
    await this.prisma.automation.delete({ where: { id } });
  }

  async findExecutions(_id: string, _userId: string) {
    // Placeholder — execution logging can be added when the scheduler is built.
    // Returns an empty array so the frontend doesn't error.
    return [];
  }
}
