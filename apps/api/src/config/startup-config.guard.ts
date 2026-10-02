import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Fail-fast guard for mandatory security secrets AND deployment-critical config
 * (e.g. Tesla's auth endpoints — not secret, but must not silently fall back to a
 * stale default if misconfigured). Prevents app startup with insecure/default
 * credentials or incomplete deployment config.
 */
@Injectable()
export class StartupConfigGuard implements OnModuleInit {
  private readonly logger = new Logger(StartupConfigGuard.name);

  onModuleInit(): void {
    this.assertRequired('TESLA_FLEET_WEBHOOK_SECRET');
    this.assertRequired('FLEET_INTERNAL_TOKEN');
    this.assertRequired('METRICS_SECRET');
    // P1.4 (Oct 2026): TeslaFleetService's own getOrThrow() already enforces these —
    // this is centralized startup diagnostics, not the only line of defense. See
    // tesla-fleet.service.ts for why TESLA_TOKEN_URL in particular must never
    // default (auth.tesla.com/oauth2/v3/token is Tesla's deprecated token-exchange
    // endpoint; fleet-auth.prd.vn.cloud.tesla.com is required now).
    this.assertRequired('TESLA_TOKEN_URL');
    this.assertRequired('TESLA_AUTH_URL');
    this.logger.log('Startup security config validated');
  }

  private assertRequired(name: string): void {
    const value = process.env[name];
    if (!value || value.trim().length === 0 || value === 'change-me') {
      throw new Error(`[startup-config] Missing or insecure ${name}`);
    }
  }
}
