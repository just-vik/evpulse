import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventStoreService } from './event-store.service';
import { SnapshotService } from './snapshot.service';
import { AuditLogService } from './audit-log.service';

@Module({
  imports:   [PrismaModule],
  providers: [EventStoreService, SnapshotService, AuditLogService],
  exports:   [EventStoreService, SnapshotService, AuditLogService],
})
export class EventsModule {}
