import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { VehiclesModule } from '../vehicles/vehicles.module';
import { EventsModule } from '../events/events.module';
import { SyncController } from './sync.controller';

@Module({
  imports:     [PrismaModule, VehiclesModule, EventsModule],
  controllers: [SyncController],
})
export class SyncModule {}
