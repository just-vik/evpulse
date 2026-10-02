import { TripsController } from '../src/trips/trips.controller';

/**
 * Regression test for GET /trips/:tripId/points exposing elevationM (telemetry audit,
 * Oct 2026, commit 3/4). TripPoint.elevationM already existed in the schema and was
 * already populated — the endpoint's own Prisma `select` just never asked for it, so
 * the field silently never reached the client. No schema/pipeline change needed here.
 */
describe('TripsController.getTripPoints — elevation exposure', () => {
  const TRIP_ID = 'trip-1';
  const VEHICLE_ID = 'veh-1';
  const USER_ID = 'user-1';

  function buildController(tripPoints: any[]) {
    const prisma = {
      trip: {
        findUnique: jest.fn().mockResolvedValue({
          id: TRIP_ID,
          vehicleId: VEHICLE_ID,
          startTime: new Date('2026-04-01T10:00:00.000Z'),
          endTime: new Date('2026-04-01T10:20:00.000Z'),
        }),
      },
      tripPoint: {
        findMany: jest.fn().mockResolvedValue(tripPoints),
      },
    };
    const vehiclesService = { findOne: jest.fn().mockResolvedValue({ id: VEHICLE_ID }) };
    const controller = new TripsController(
      {} as any, // tripDetectorService — unused by getTripPoints
      vehiclesService as any,
      {} as any, // maintenance
      {} as any, // tripReconcilerService
      {} as any, // tripPostProcessorService
      {} as any, // billingService
      prisma as any,
    );
    return { controller, prisma };
  }

  it('включает elevationM в select и возвращает его как elev, когда задано', async () => {
    const { controller, prisma } = buildController([
      {
        timestamp: new Date('2026-04-01T10:00:00.000Z'),
        latitude: 50.1,
        longitude: 8.6,
        speed: 42,
        power: 7.5,
        soc: 61,
        elevationM: 123.4,
      },
    ]);

    const result = await controller.getTripPoints(TRIP_ID, { user: { id: USER_ID } } as any);

    // The select clause itself must ask for elevationM — the whole bug was that it didn't.
    const [{ select }] = prisma.tripPoint.findMany.mock.calls[0];
    expect(select).toHaveProperty('elevationM', true);

    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({
      lat: 50.1,
      lng: 8.6,
      spd: 42,
      pwr: 7.5,
      soc: 61,
      elev: 123.4,
    });
  });

  it('возвращает elev: null, когда elevationM отсутствует, без изменения остальных полей', async () => {
    const { controller } = buildController([
      {
        timestamp: new Date('2026-04-01T10:00:00.000Z'),
        latitude: 50.1,
        longitude: 8.6,
        speed: 42,
        power: 7.5,
        soc: 61,
        elevationM: null,
      },
    ]);

    const result = await controller.getTripPoints(TRIP_ID, { user: { id: USER_ID } } as any);

    expect(result.points[0]).toMatchObject({
      lat: 50.1,
      lng: 8.6,
      spd: 42,
      pwr: 7.5,
      soc: 61,
      elev: null,
    });
  });
});
