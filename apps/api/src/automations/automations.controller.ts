import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Request,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  AutomationsService,
  CreateAutomationDto,
  UpdateAutomationDto,
} from './automations.service';

@ApiTags('automations')
@Controller('automations')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class AutomationsController {
  constructor(private readonly svc: AutomationsService) {}

  /** GET /automations — list all automations for the current user */
  @Get()
  @ApiOperation({ summary: 'List all automations' })
  findAll(@Request() req: any) {
    return this.svc.findAll(req.user.id);
  }

  /** GET /automations/:id */
  @Get(':id')
  @ApiOperation({ summary: 'Get a single automation' })
  findOne(@Param('id') id: string, @Request() req: any) {
    return this.svc.findOne(id, req.user.id);
  }

  /** POST /automations */
  @Post()
  @ApiOperation({ summary: 'Create an automation' })
  create(@Body() dto: CreateAutomationDto, @Request() req: any) {
    return this.svc.create(req.user.id, dto);
  }

  /** PATCH /automations/:id */
  @Patch(':id')
  @ApiOperation({ summary: 'Update an automation' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAutomationDto,
    @Request() req: any,
  ) {
    return this.svc.update(id, req.user.id, dto);
  }

  /** DELETE /automations/:id */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an automation' })
  async remove(@Param('id') id: string, @Request() req: any) {
    await this.svc.remove(id, req.user.id);
  }

  /** GET /automations/:id/executions */
  @Get(':id/executions')
  @ApiOperation({ summary: 'Get execution history for an automation' })
  executions(@Param('id') id: string, @Request() req: any) {
    return this.svc.findExecutions(id, req.user.id);
  }
}
