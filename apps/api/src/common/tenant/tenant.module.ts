import { Global, Module } from '@nestjs/common';
import { TenantContext } from './tenant.context';

/**
 * TenantModule — global module that provides TenantContext for DI everywhere.
 *
 * Import once in AppModule. Any service (including PrismaService) can inject
 * TenantContext without explicitly importing this module.
 */
@Global()
@Module({
  providers: [TenantContext],
  exports: [TenantContext],
})
export class TenantModule {}
