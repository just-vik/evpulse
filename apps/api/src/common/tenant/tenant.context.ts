import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

interface TenantStore {
  tenantId: string;
}

/**
 * TenantContext — carries the current tenant ID through async call stacks.
 *
 * Uses Node's AsyncLocalStorage so the context is propagated automatically
 * through all awaited calls without passing tenantId as an explicit parameter.
 *
 * Self-hosted mode: `current()` always returns 'selfhosted' (default fallback).
 * SaaS mode: register TenantInterceptor as a global interceptor to call
 *   `run(user.tenantId, handler)` for every request.
 */
@Injectable()
export class TenantContext {
  private readonly storage = new AsyncLocalStorage<TenantStore>();

  /**
   * Wrap `fn` execution in the given tenant context.
   * All Prisma calls inside `fn` will automatically filter by `tenantId`.
   */
  run<T>(tenantId: string, fn: () => T): T {
    return this.storage.run({ tenantId }, fn);
  }

  /**
   * Return the current tenant ID.
   * Falls back to 'selfhosted' when called outside a request context
   * (background workers, cron jobs, tests).
   */
  current(): string {
    return this.storage.getStore()?.tenantId ?? 'selfhosted';
  }
}
