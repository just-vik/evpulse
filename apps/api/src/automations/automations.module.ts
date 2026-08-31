import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AutomationsController } from './automations.controller';
import { AutomationsService } from './automations.service';

@Module({
  imports:     [PrismaModule],
  controllers: [AutomationsController],
  providers:   [AutomationsService],
  exports:     [AutomationsService],
})
export class AutomationsModule {}
