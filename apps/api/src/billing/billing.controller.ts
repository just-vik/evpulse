import { Controller, Get, Post, Body, UseGuards, Request, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BillingService } from './billing.service';
import { ApiUsageService } from './api-usage.service';
import { PrismaService } from '../prisma/prisma.service';

class CreateCheckoutDto {
  @IsEnum(['PRO', 'FLEET'])
  plan: 'PRO' | 'FLEET';
}

@ApiTags('billing')
@Controller('billing')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class BillingController {
  constructor(
    private readonly billingSvc: BillingService,
    private readonly apiUsage: ApiUsageService,
    private readonly prisma: PrismaService,
  ) {}

  /** Tesla API usage stats for the current month (per-vehicle signal/wake/command counts). */
  @Get('api-usage')
  @ApiOperation({ summary: 'Get Tesla API usage counters for current month' })
  async apiUsageStats(@Request() req: any) {
    const userId = req.user.id as string;
    const vehicles = await this.prisma.vehicle.findMany({
      where: { userId },
      select: { id: true },
    });
    return this.apiUsage.getUserUsage(vehicles.map((v) => v.id));
  }

  /** Current plan + entitlements for the authenticated user */
  @Get('me')
  @ApiOperation({ summary: 'Get current subscription & entitlements' })
  async me(@Request() req: any) {
    return this.billingSvc.getCurrent(req.user.id);
  }

  /** Create a Stripe Checkout session and return the redirect URL */
  @Post('checkout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start Stripe Checkout for a plan upgrade' })
  async checkout(@Request() req: any, @Body() dto: CreateCheckoutDto) {
    try {
      return await this.billingSvc.createCheckoutSession(req.user.id, dto.plan);
    } catch (err: any) {
      if (err?.message === 'Stripe not configured') {
        throw new ServiceUnavailableException('Billing is not available yet. Please contact support.');
      }
      throw err;
    }
  }

  /** Create a Stripe Billing Portal session (manage card / cancel) */
  @Post('portal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open Stripe Billing Portal' })
  async portal(@Request() req: any) {
    try {
      return await this.billingSvc.createPortalSession(req.user.id);
    } catch (err: any) {
      if (err?.message === 'Stripe not configured') {
        throw new ServiceUnavailableException('Billing is not available yet. Please contact support.');
      }
      throw err;
    }
  }
}
