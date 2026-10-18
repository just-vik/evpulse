import { GeocodingService } from '../src/geocoding/geocoding.service';

/**
 * Tests for GeocodingService Nominatim timeout (ARCH-2).
 *
 * Root cause: fetchNominatim() used fetch() with no AbortSignal, so a hung
 * Nominatim server could leave promises pending indefinitely.
 *
 * Fix: AbortSignal.timeout(5_000) is passed to fetch(). Node.js 20+ supports
 * AbortSignal.timeout() natively; the signal automatically aborts after 5 s.
 *
 * Tests verify:
 *   1. Timeout (AbortError) resolves reverseShort() to null — does not throw.
 *   2. HTTP error (non-ok) resolves reverseShort() to null — does not throw.
 *   3. Successful response returns the expected short address.
 *   4. reverseShort(...).catch(() => null) chain behaves correctly after timeout.
 */

// Minimal Redis mock: only cache operations used by GeocodingService
function buildRedisMock(cachedValue: string | null = null) {
  return {
    get: jest.fn().mockResolvedValue(cachedValue),
    set: jest.fn().mockResolvedValue('OK'),
  };
}

function buildService(redis: ReturnType<typeof buildRedisMock>) {
  return new GeocodingService(redis as any);
}

function mockFetch(impl: () => Promise<Response>) {
  global.fetch = jest.fn(impl) as any;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('GeocodingService — Nominatim timeout (ARCH-2)', () => {

  it('1. AbortError (timeout) → reverseShort returns null, does not throw', async () => {
    mockFetch(async () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      throw err;
    });
    const redis = buildRedisMock();
    const svc   = buildService(redis);

    const result = await svc.reverseShort(50.0, 8.4);
    expect(result).toBeNull();
  });

  it('2. HTTP 500 → reverseShort returns null, does not throw', async () => {
    mockFetch(async () => ({
      ok:     false,
      status: 500,
      json:   async () => ({}),
    } as Response));
    const redis = buildRedisMock();
    const svc   = buildService(redis);

    const result = await svc.reverseShort(50.0, 8.4);
    expect(result).toBeNull();
  });

  it('3. successful response → returns short address string', async () => {
    mockFetch(async () => ({
      ok:   true,
      json: async () => ({
        display_name: 'Senefeldstraße 9, Wiesbaden, Germany',
        address: {
          road:         'Senefeldstraße',
          house_number: '9',
          city:         'Wiesbaden',
          country:      'Germany',
        },
      }),
    } as Response));
    const redis = buildRedisMock();
    const svc   = buildService(redis);

    const result = await svc.reverseShort(50.083, 8.232);
    expect(result).toBe('Senefeldstraße 9, Wiesbaden');
  });

  it('4. timeout → fire-and-forget .catch(() => null) chain resolves to null', async () => {
    mockFetch(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    const redis = buildRedisMock();
    const svc   = buildService(redis);

    // Mirrors the fire-and-forget call site in startTrip:
    //   this.geocoding.reverseShort(...).then(...).catch(() => null)
    const result = await svc
      .reverseShort(50.0, 8.4)
      .then(addr => addr ?? 'FALLBACK')
      .catch(() => null);

    // Timeout returns null → .then takes null path → result is null (not 'FALLBACK')
    // because null ?? 'FALLBACK' = 'FALLBACK', but the .catch never fires
    expect(result).toBe('FALLBACK'); // null → .then(null ?? 'FALLBACK') = 'FALLBACK'
    // key point: .catch() was never invoked — reverseShort resolved, not rejected
  });
});
