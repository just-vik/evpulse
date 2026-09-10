import 'reflect-metadata';
import { BatteryController } from '../src/battery/battery.controller';
import { BatteryHealthService } from '../src/battery/battery-health.service';
import { BatteryAnalyticsService } from '../src/battery/battery-analytics.service';

/**
 * Regression guard for the single-canonical-writer decision
 * (docs/calculations/battery-health.md "Canonical engine"): only
 * BatteryAnalyticsService may write to BatteryHealth. BatteryHealthService
 * (Engine A) is legacy/comparison-only and must never run automatically or
 * be triggered by the recalculate endpoint again.
 *
 * Two independent things could silently reintroduce the second writer:
 * someone re-adding @Cron to BatteryHealthService.scheduledCapacityBackfill,
 * or someone re-adding the second service call inside the /recalculate
 * handler. Each gets its own check below rather than one combined test, so
 * a future regression in either spot fails with an unambiguous message.
 */

describe('BatteryHealth writer ownership', () => {
  it('BatteryHealthService.scheduledCapacityBackfill is NOT scheduled (no @Cron metadata)', () => {
    const metadata = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      BatteryHealthService.prototype.scheduledCapacityBackfill,
    );
    expect(metadata).toBeUndefined();
  });

  it('sanity check: the metadata key itself would actually catch a live @Cron (positive control)', () => {
    // Proves the check above isn't vacuously passing due to a wrong key name —
    // BatteryAnalyticsService's own cron is still scheduled and must still
    // carry this exact metadata.
    const metadata = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      BatteryAnalyticsService.prototype.scheduledBatteryAnalytics,
    );
    expect(metadata).toBeDefined();
  });

  it('POST /battery/:vehicleId/recalculate calls only the canonical engine', async () => {
    const vehicleId = 'veh-1';
    const userId = 'user-1';

    const batteryAnalyticsService = {
      updateBatteryMetrics: jest.fn().mockResolvedValue(undefined),
      getBatteryHealth: jest.fn().mockResolvedValue({ sohPercent: 91 }),
    } as any;
    const batteryHealthService = {
      estimateCapacityFromCharging: jest.fn(),
    } as any;
    const vehiclesService = {
      findOne: jest.fn().mockResolvedValue({ id: vehicleId }),
    } as any;

    const controller = new BatteryController(
      batteryAnalyticsService,
      vehiclesService,
      batteryHealthService,
    );

    const result = await controller.recalculate(vehicleId, { user: { id: userId } });

    expect(batteryAnalyticsService.updateBatteryMetrics).toHaveBeenCalledWith(vehicleId);
    expect(batteryHealthService.estimateCapacityFromCharging).not.toHaveBeenCalled();
    expect(result).toEqual({ sohPercent: 91 });
  });
});
