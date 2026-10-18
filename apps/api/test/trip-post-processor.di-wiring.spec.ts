import { Test } from '@nestjs/testing';
import { TripPostProcessorService } from '../src/trips/trip-post-processor.service';
import { TariffResolverService, TARIFF_RESOLVER_CONFIG } from '../src/charging/tariff-resolver.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Verifies that TripPostProcessorService correctly receives TariffResolverService
 * via NestJS DI — not just via direct constructor call.
 *
 * Root cause of the check: `tariffResolver?` uses TypeScript `?` syntax (required for
 * positional reasons — optional params precede it) but intentionally omits the `@Optional()`
 * NestJS decorator. The emitted `design:paramtypes` metadata lists `TariffResolverService`
 * as the token; this test confirms NestJS resolves it to a real instance and not `undefined`.
 */
describe('TripPostProcessorService — NestJS DI wiring', () => {

  it('tariffResolver is injected (not undefined) when TariffResolverService is registered', async () => {
    const module = await Test.createTestingModule({
      providers: [
        TripPostProcessorService,
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: TariffResolverService,
          useValue: { resolve: jest.fn() },
        },
        {
          provide: TARIFF_RESOLVER_CONFIG,
          useValue: { canonicalDefaultRate: 0.35, canonicalCurrency: 'EUR' },
        },
      ],
    }).compile();

    const svc = module.get(TripPostProcessorService);

    // If @Optional() were present and TariffResolverService were missing, tariffResolver
    // would be undefined and processMissingCost would return { repaired: 0 }.
    // Without @Optional(), NestJS injects the real instance — verified here.
    expect((svc as any).tariffResolver).toBeDefined();
    expect((svc as any).tariffResolver).not.toBeUndefined();
  });

  it('NestJS throws at module compile time when TariffResolverService is not registered', async () => {
    // Confirms @Optional() is absent: missing provider → startup error, not silent undefined.
    await expect(
      Test.createTestingModule({
        providers: [
          TripPostProcessorService,
          {
            provide: PrismaService,
            useValue: {},
          },
          // TariffResolverService intentionally omitted
        ],
      }).compile(),
    ).rejects.toThrow(/TariffResolverService/);
  });
});
