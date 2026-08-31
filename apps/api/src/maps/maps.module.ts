import { Module } from '@nestjs/common';
import { MapMatchingService } from './map-matching.service';

@Module({
  providers: [MapMatchingService],
  exports:   [MapMatchingService],
})
export class MapsModule {}
