import { registerAs } from '@nestjs/config';

export default registerAs('billing', () => ({
  stripeSecretKey:    process.env.STRIPE_SECRET_KEY ?? '',
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  pricePro:           process.env.STRIPE_PRICE_PRO ?? '',
  priceFleet:         process.env.STRIPE_PRICE_FLEET ?? '',
  frontendUrl:        process.env.FRONTEND_URL ?? 'http://localhost:3000',
}));
