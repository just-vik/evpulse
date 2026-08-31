import { Controller, Post, Req, Headers, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { BillingService } from './billing.service';

@ApiTags('billing')
@Controller('billing/stripe-webhook')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(private readonly billingSvc: BillingService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Stripe webhook receiver' })
  async handle(
    @Req() req: any,
    @Headers('stripe-signature') sig: string,
  ) {
    const rawBody: Buffer = req.rawBody;

    let event;
    try {
      event = this.billingSvc.constructEvent(rawBody, sig);
    } catch (err: any) {
      this.logger.error(`Stripe webhook signature verification failed: ${err.message}`);
      // Return 400 so Stripe retries
      throw err;
    }

    if (await this.billingSvc.isEventProcessed(event.id)) {
      return { received: true };
    }

    await this.billingSvc.handleEvent(event);
    return { received: true };
  }
}
