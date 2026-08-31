import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { VehiclesService } from './vehicles.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@ApiTags('vehicles')
@Controller('vehicles')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class VehiclesController {
  constructor(private readonly vehiclesService: VehiclesService) {}

  @Get()
  @ApiOperation({ summary: 'Get all vehicles for current user' })
  async findAll(@Request() req) {
    return this.vehiclesService.findAllForUser(req.user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get vehicle by ID' })
  async findOne(@Param('id') id: string, @Request() req) {
    return this.vehiclesService.findOne(id, req.user.id);
  }

  @Get(':id/spec')
  @ApiOperation({ summary: 'Get enriched vehicle spec (model, battery, drivetrain)' })
  async getSpec(@Param('id') id: string, @Request() req) {
    return this.vehiclesService.getSpec(id, req.user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Add a new vehicle' })
  async create(
    @Request() req,
    @Body() createVehicleDto: {
      teslaId?: string;
      vin: string;
      model: string;
      trim?: string;
      year?: number;
      batteryCapacityNominal?: number;
      batteryCapacityUsable?: number;
    },
  ) {
    return this.vehiclesService.create(req.user.id, createVehicleDto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update vehicle' })
  async update(
    @Param('id') id: string,
    @Request() req,
    @Body() updateData: { trim?: string; year?: number; status?: string },
  ) {
    return this.vehiclesService.update(id, req.user.id, updateData);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove vehicle' })
  async remove(@Param('id') id: string, @Request() req) {
    return this.vehiclesService.remove(id, req.user.id);
  }
}
