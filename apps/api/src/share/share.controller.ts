import {
  Controller, Get, Post, Delete, Param, Req, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ShareService } from './share.service';

@ApiTags('share')
@Controller('share')
export class ShareController {
  constructor(private readonly shareService: ShareService) {}

  /** Create (or reuse) a 7-day public share link for a trip */
  @Post('trips/:tripId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create a public share link for a trip (7 days TTL)' })
  createTripShare(@Param('tripId') tripId: string, @Req() req: any) {
    return this.shareService.createTripShare(tripId, req.user.id);
  }

  /** Revoke the share link for a trip */
  @Delete('trips/:tripId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Revoke the share link for a trip' })
  async revokeTripShare(@Param('tripId') tripId: string, @Req() req: any) {
    await this.shareService.revokeTripShare(tripId, req.user.id);
    return { revoked: true };
  }

  /** Public endpoint — no auth required */
  @Get(':token')
  @ApiOperation({ summary: 'Get public trip data by share token (no auth)' })
  getPublicTrip(@Param('token') token: string) {
    return this.shareService.getPublicTrip(token);
  }
}
