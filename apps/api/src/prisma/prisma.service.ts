import { Injectable, OnModuleInit, OnModuleDestroy, Logger, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { TenantContext } from '../common/tenant/tenant.context';

// Models that carry a tenantId column and should be filtered automatically.
const TENANT_MODELS = new Set([
  'User', 'Vehicle', 'Trip', 'ChargingSession', 'NotificationRule', 'AuditEvent',
]);

// Read operations that should have a tenantId filter injected into WHERE.
const FILTER_ACTIONS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow',
  'count', 'aggregate', 'groupBy',
  'updateMany', 'deleteMany',
]);

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(
    @Optional() private readonly tenantContext?: TenantContext,
  ) {
    super({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'info' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });
  }

  async onModuleInit() {
    this.setupTenantMiddleware();
    await this.$connect();
    this.logger.log('Prisma connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Prisma disconnected from database');
  }

  /**
   * Prisma middleware that automatically injects tenantId into:
   *   - bulk reads  (findMany, findFirst, count, …)
   *   - bulk writes (updateMany, deleteMany)
   *   - creates     (create, createMany, upsert.create)
   *
   * findUnique / update / delete are identity-scoped (use IDs) and are
   * intentionally left unfiltered — they are safe by design.
   *
   * Falls back gracefully when TenantContext is not available (tests, workers
   * that run without a request context always get tenantId='selfhosted').
   */
  private setupTenantMiddleware(): void {
    if (!this.tenantContext) return;

    const ctx = this.tenantContext;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).$use(async (params: any, next: (p: any) => Promise<any>) => {
      if (!TENANT_MODELS.has(params.model ?? '')) return next(params);

      const tenantId = ctx.current();

      if (FILTER_ACTIONS.has(params.action)) {
        params.args        ??= {};
        params.args.where   = { ...params.args.where, tenantId };
      }

      if (params.action === 'create') {
        params.args.data = { ...params.args.data, tenantId };
      }

      if (params.action === 'createMany' && Array.isArray(params.args?.data)) {
        params.args.data = params.args.data.map((d: Record<string, unknown>) => ({ ...d, tenantId }));
      }

      if (params.action === 'upsert') {
        // Inject tenantId into the create branch; leave update branch untouched
        // (re-writing tenantId on update would break cross-tenant safety checks).
        params.args.create = { ...params.args.create, tenantId };
      }

      return next(params);
    });
  }
}
