import { Controller, Get, Patch, Param, Body, UseGuards, Request } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VehicleSettingsService } from './vehicle-settings.service';
import { UpdateVehicleSettingsDto } from './dto/update-vehicle-settings.dto';

@Controller('vehicles/:vehicleId/settings')
@UseGuards(JwtAuthGuard)
export class VehicleSettingsController {
  constructor(private readonly svc: VehicleSettingsService) {}

  @Get()
  getSettings(@Param('vehicleId') vehicleId: string, @Request() req: any) {
    return this.svc.getSettings(vehicleId, req.user.id);
  }

  @Patch()
  updateSettings(
    @Param('vehicleId') vehicleId: string,
    @Body() dto: UpdateVehicleSettingsDto,
    @Request() req: any,
  ) {
    return this.svc.updateSettings(vehicleId, req.user.id, dto);
  }
}

