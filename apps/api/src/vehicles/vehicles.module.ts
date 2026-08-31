import { Module } from '@nestjs/common';
import { VehiclesService } from './vehicles.service';
import { VehiclesController } from './vehicles.controller';
import { VehicleSettingsService } from './vehicle-settings.service';
import { VehicleSettingsController } from './vehicle-settings.controller';

@Module({
  controllers: [VehiclesController, VehicleSettingsController],
  providers: [VehiclesService, VehicleSettingsService],
  exports: [VehiclesService, VehicleSettingsService],
})
export class VehiclesModule {}
