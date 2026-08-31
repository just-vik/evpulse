import { Body, Controller, Headers, Post, RawBodyRequest, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Request } from 'express';
import { FleetTelemetryService } from './fleet-telemetry.service';

@Controller('fleet/telemetry')
export class FleetTelemetryController {
  constructor(
    private readonly fleetTelemetry: FleetTelemetryService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Public webhook — used for Tesla Fleet API event push (HMAC-signed).
   * Validates x-tesla-signature header against TESLA_FLEET_WEBHOOK_SECRET.
   */
  @Post('webhook')
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Body() payload: any,
    @Headers('x-tesla-signature') signature?: string,
  ) {
    const secret =
      this.configService.get<string>('tesla.fleetWebhookSecret') ||
      process.env.TESLA_FLEET_WEBHOOK_SECRET;

    // Fail closed: webhook secret must be configured and non-default.
    if (!secret || secret === 'super-long-random-string') {
      throw new UnauthorizedException('Telemetry webhook secret is not configured');
    }

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(payload));
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    if (!signature || signature !== expected) {
      throw new UnauthorizedException('Invalid Tesla webhook signature');
    }

    await this.fleetTelemetry.handleIncomingPayload(payload);
    return { ok: true };
  }

  /**
   * Internal ingest endpoint — used by the tesla-fleet-telemetry sidecar container.
   * Authenticates via x-internal-token header (shared secret, docker-network only).
   * No HMAC required since fleet-telemetry server can't produce HMAC signatures.
   */
  @Post('ingest')
  async handleIngest(
    @Body() payload: any,
    @Headers('x-internal-token') token?: string,
  ) {
    const expected = this.configService.get<string>('FLEET_INTERNAL_TOKEN') ||
      process.env.FLEET_INTERNAL_TOKEN;

    // Fail closed: internal token must be configured and non-default.
    if (!expected || expected === 'changeme') {
      throw new UnauthorizedException('Internal ingest token is not configured');
    }

    if (token !== expected) {
      throw new UnauthorizedException('Invalid internal token');
    }

    await this.fleetTelemetry.handleIncomingPayload(payload);
    return { ok: true };
  }
}
