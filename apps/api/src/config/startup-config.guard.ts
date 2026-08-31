import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Fail-fast guard for mandatory security secrets.
 * Prevents app startup with insecure/default credentials.
 */
@Injectable()
export class StartupConfigGuard implements OnModuleInit {
  private readonly logger = new Logger(StartupConfigGuard.name);

  onModuleInit(): void {
    this.assertRequiredSecret('TESLA_FLEET_WEBHOOK_SECRET');
    this.assertRequiredSecret('FLEET_INTERNAL_TOKEN');
    this.assertRequiredSecret('METRICS_SECRET');
    this.logger.log('Startup security config validated');
  }

  private assertRequiredSecret(name: string): void {
    const value = process.env[name];
    if (!value || value.trim().length === 0 || value === 'change-me') {
      throw new Error(`[startup-config] Missing or insecure ${name}`);
    }
  }
}
