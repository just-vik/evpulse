import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module';
import { SystemMaintenanceCronService } from './system-maintenance.cron';

@Module({
  imports: [TripsModule],
  providers: [SystemMaintenanceCronService],
})
export class MaintenanceModule {}
