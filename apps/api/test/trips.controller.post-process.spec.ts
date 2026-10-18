import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TripsController } from '../src/trips/trips.controller';

/**
 * Regression tests for DEF-2 — POST /trips/post-process cross-tenant boundary.
 *
 * Before the fix, omitting vehicleId skipped the ownership check and ran
 * processUnrated for ALL vehicles in the system (DoS / resource-abuse vector).
 *
 * After the fix:
 *   1. Missing vehicleId → 400 Bad Request (processing never starts).
 *   2. Own vehicleId → ownership check passes, processUnrated called with that id.
 *   3. Foreign vehicleId → ForbiddenException from vehiclesService.findOne.
 *   4. In all rejection cases, processUnrated is never called.
 */
describe('TripsController.postProcess — vehicleId boundary enforcement', () => {
  const USER_ID    = 'user-1';
  const VEHICLE_ID = 'veh-1';
  const OTHER_VID  = 'veh-other';

  const req = { user: { id: USER_ID } };

  function buildController(overrides: {
    findOneImpl?: (id: string, userId: string) => Promise<any>;
    processUnratedResult?: object;
  } = {}) {
    const processUnrated = jest.fn().mockResolvedValue(
      overrides.processUnratedResult ?? { processed: 3 },
    );

    const vehiclesService = {
      findOne: overrides.findOneImpl
        ? jest.fn().mockImplementation(overrides.findOneImpl)
        : jest.fn().mockResolvedValue({ id: VEHICLE_ID }),
    };

    const controller = new TripsController(
      {} as any,        // tripDetectorService
      vehiclesService as any,
      {} as any,        // maintenance
      {} as any,        // tripReconcilerService
      { processUnrated } as any,
      {} as any,        // billingService
      {} as any,        // prisma
    );
    return { controller, vehiclesService, processUnrated };
  }

  it('1. missing vehicleId → BadRequestException, processUnrated not called', async () => {
    const { controller, processUnrated } = buildController();

    await expect(
      controller.postProcess(req as any, undefined, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(processUnrated).not.toHaveBeenCalled();
  });

  it('2. own vehicleId → ownership check passes, processUnrated called with that vehicleId', async () => {
    const { controller, vehiclesService, processUnrated } = buildController();

    const result = await controller.postProcess(req as any, VEHICLE_ID, undefined);

    expect(vehiclesService.findOne).toHaveBeenCalledWith(VEHICLE_ID, USER_ID);
    expect(processUnrated).toHaveBeenCalledWith(VEHICLE_ID, false);
    expect(result).toMatchObject({ status: 'ok', processed: 3 });
  });

  it('3. own vehicleId with force=true → processUnrated called with force=true', async () => {
    const { controller, processUnrated } = buildController();

    await controller.postProcess(req as any, VEHICLE_ID, 'true');

    expect(processUnrated).toHaveBeenCalledWith(VEHICLE_ID, true);
  });

  it('4. foreign vehicleId → ForbiddenException from vehiclesService, processUnrated not called', async () => {
    const { controller, processUnrated } = buildController({
      findOneImpl: (id, userId) => {
        if (id === OTHER_VID && userId === USER_ID) {
          throw new ForbiddenException('Access denied');
        }
        return Promise.resolve({ id });
      },
    });

    await expect(
      controller.postProcess(req as any, OTHER_VID, undefined),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(processUnrated).not.toHaveBeenCalled();
  });

  it('5. empty-string vehicleId is treated as absent → BadRequestException', async () => {
    const { controller, processUnrated } = buildController();

    await expect(
      controller.postProcess(req as any, '', undefined),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(processUnrated).not.toHaveBeenCalled();
  });
});
