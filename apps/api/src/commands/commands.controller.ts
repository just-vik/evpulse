import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, Req, UseGuards, ParseIntPipe, DefaultValuePipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CommandsService } from './commands.service';

@Controller('commands')
@UseGuards(AuthGuard('jwt'))
export class CommandsController {
  constructor(private readonly commandsService: CommandsService) {}

  // ── Presets ──────────────────────────────────────────────────────────────

  @Get('presets')
  getPresets(@Req() req: any, @Query('vehicleId') vehicleId?: string) {
    return this.commandsService.getPresets(req.user.id, vehicleId);
  }

  @Post('presets')
  createPreset(
    @Req() req: any,
    @Body() dto: {
      vehicleId?: string;
      name: string;
      command: string;
      params?: any;
      icon?: string;
      sortOrder?: number;
    },
  ) {
    return this.commandsService.createPreset(req.user.id, dto);
  }

  @Patch('presets/:id')
  updatePreset(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: { name?: string; params?: any; icon?: string; sortOrder?: number },
  ) {
    return this.commandsService.updatePreset(req.user.id, id, dto);
  }

  @Delete('presets/:id')
  deletePreset(@Req() req: any, @Param('id') id: string) {
    return this.commandsService.deletePreset(req.user.id, id);
  }

  // ── History ──────────────────────────────────────────────────────────────

  @Get('history')
  getHistory(
    @Req() req: any,
    @Query('vehicleId') vehicleId: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.commandsService.getHistory(req.user.id, vehicleId, limit);
  }
}
