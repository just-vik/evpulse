import { Injectable, Logger } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { PrismaService } from '../prisma/prisma.service'
import { isWorkerRole } from '../runtime/runtime-role'

export enum VehicleState {
  OFFLINE  = 'offline',
  SLEEPING = 'sleeping',
  PARKED   = 'parked',
  CHARGING = 'charging',
  DRIVING  = 'driving',
  WAKING   = 'waking',
}

export interface VehicleStateData {
  state: VehicleState
  lastUpdate: Date
  pollingInterval: number
  shouldPoll: boolean
}

@Injectable()
export class VehicleStateMachineService {

  private readonly logger = new Logger(VehicleStateMachineService.name)

  private readonly POLLING_INTERVALS = {
    [VehicleState.DRIVING]:  2,
    [VehicleState.CHARGING]: 8,
    [VehicleState.PARKED]:   30,
    [VehicleState.SLEEPING]: 600,
    [VehicleState.OFFLINE]:  0,
    [VehicleState.WAKING]:   5,
  }

  private vehicleStates = new Map<string, VehicleStateData>()

  constructor(private prisma: PrismaService) { }

  /**
   * Update vehicle state from Tesla API response
   */
  async updateVehicleState(vehicleId: string, data: any): Promise<VehicleState> {

    const newState = this.determineState(data)
    const now = new Date()

    const chargingState: string | null = data?.charge_state?.charging_state ?? null;
    const locked: boolean = data?.vehicle_state?.locked ?? true;
    const odometer: number | null = data?.vehicle_state?.odometer != null
      ? +(data.vehicle_state.odometer * 1.60934).toFixed(2)
      : null;

    const record = await this.prisma.vehicleState.upsert({
      where: { vehicleId },
      create: {
        vehicleId,
        state:         newState,
        chargingState,
        locked,
        odometer,
        timestamp:  now,
        lastUpdate: now,
      },
      update: {
        state:         newState,
        chargingState,
        locked,
        odometer,
        timestamp:  now,
        lastUpdate: now,
      },
    })

    const stateData: VehicleStateData = {
      state: newState,
      lastUpdate: record.lastUpdate,
      pollingInterval: this.POLLING_INTERVALS[newState],
      shouldPoll: newState !== VehicleState.OFFLINE
    }

    this.vehicleStates.set(vehicleId, stateData)

    this.logger.debug(`Vehicle ${vehicleId} state → ${newState}`)

    return newState
  }

  /**
   * Update vehicle state from a fleet telemetry point.
   * Called on every processed batch so the state stays fresh even when
   * REST polling is deferred (e.g. "fleet live — REST poll deferred 5min").
   */
  /**
   * Returns { justWoke, newState, prevState } describing the state transition.
   * justWoke = true when the vehicle transitioned out of a sleep/offline state —
   * callers use this to trigger an immediate REST poll for fresh data.
   */
  async updateFromTelemetry(
    vehicleId: string,
    point: {
      speed?: number | null;
      power?: number | null;
      charging_state?: string | null;
    },
  ): Promise<{ justWoke: boolean; newState: VehicleState; prevState: VehicleState | null }> {
    const speed = point.speed ?? 0;
    const power = point.power ?? 0;
    const chargingState = point.charging_state ?? null;

    let newState: VehicleState;
    if (speed > 2) {
      newState = VehicleState.DRIVING;
    } else if (chargingState === 'Charging') {
      // Only use charging_state signal — power alone is ambiguous (HVAC, preconditioning)
      newState = VehicleState.CHARGING;
    } else {
      newState = VehicleState.PARKED;
    }

    // Detect wake transition: sleeping/offline/waking → parked/driving/charging
    // When cache is empty (API restart), fall back to DB to detect the transition.
    const SLEEP_STATES = new Set<VehicleState>([VehicleState.SLEEPING, VehicleState.OFFLINE, VehicleState.WAKING]);
    const prevCached = this.vehicleStates.get(vehicleId);
    let prevState: VehicleState | null = prevCached?.state ?? null;
    if (!prevCached) {
      try {
        const dbRow = await this.prisma.vehicleState.findUnique({
          where: { vehicleId }, select: { state: true },
        });
        prevState = dbRow?.state as VehicleState | null;
      } catch { /* non-fatal */ }
    }
    const justWoke = prevState != null && SLEEP_STATES.has(prevState) && !SLEEP_STATES.has(newState);

    const now = new Date();
    try {
      // Optimistic locking: read current version, increment on write.
      const existing = await this.prisma.vehicleState.findUnique({
        where: { vehicleId },
        select: { version: true },
      });

      // When Fleet telemetry reports charging_state, persist it alongside state.
      // This keeps vehicleState.chargingState in sync even between slow REST polls.
      const chargingStateUpdate = chargingState != null ? { chargingState } : {};

      if (!existing) {
        await this.prisma.vehicleState.create({
          data: { vehicleId, state: newState, ...chargingStateUpdate, timestamp: now, lastUpdate: now },
        });
      } else {
        const currentVersion = existing.version ?? 0;
        const result = await this.prisma.vehicleState.updateMany({
          where:  { vehicleId, version: currentVersion },
          data:   { state: newState, ...chargingStateUpdate, lastUpdate: now, version: { increment: 1 } },
        });
        if (result.count === 0) {
          this.logger.debug(`updateFromTelemetry: stale-write skipped for ${vehicleId} (version conflict)`);
          // Still update in-memory cache so WebSocket diff and status checks reflect latest
          // intent even when the DB write lost a race with another concurrent update.
          this.vehicleStates.set(vehicleId, {
            state: newState,
            lastUpdate: now,
            pollingInterval: this.POLLING_INTERVALS[newState],
            shouldPoll: true,
          });
          return { justWoke, newState, prevState };
        }
      }

      this.vehicleStates.set(vehicleId, {
        state: newState,
        lastUpdate: now,
        pollingInterval: this.POLLING_INTERVALS[newState],
        shouldPoll: true,
      });
      if (justWoke) this.logger.log(`Vehicle ${vehicleId} just woke via MQTT (${prevState} → ${newState})`);
      else this.logger.debug(`Vehicle ${vehicleId} state (fleet telemetry) → ${newState}`);
    } catch (e: any) {
      this.logger.warn(`updateFromTelemetry failed for ${vehicleId}: ${e.message}`);
    }
    return { justWoke, newState, prevState };
  }

  /**
   * Explicitly mark vehicle as SLEEPING when Tesla summary returns state='asleep'.
   * Separate from updateVehicleState (which can't derive SLEEPING from null data).
   */
  async setSleeping(vehicleId: string): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.vehicleState.upsert({
        where:  { vehicleId },
        create: { vehicleId, state: VehicleState.SLEEPING, timestamp: now, lastUpdate: now },
        update: { state: VehicleState.SLEEPING, lastUpdate: now },
      });
      this.vehicleStates.set(vehicleId, {
        state: VehicleState.SLEEPING,
        lastUpdate: now,
        pollingInterval: this.POLLING_INTERVALS[VehicleState.SLEEPING],
        shouldPoll: false,
      });
      this.logger.debug(`Vehicle ${vehicleId} → sleeping`);
    } catch { /* non-fatal */ }
  }

  /**
   * Set vehicle state to WAKING when a wake command is sent.
   */
  async setWaking(vehicleId: string): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.vehicleState.upsert({
        where:  { vehicleId },
        create: { vehicleId, state: VehicleState.WAKING, timestamp: now, lastUpdate: now },
        update: { state: VehicleState.WAKING, lastUpdate: now },
      });
      this.vehicleStates.set(vehicleId, {
        state: VehicleState.WAKING,
        lastUpdate: now,
        pollingInterval: this.POLLING_INTERVALS[VehicleState.WAKING],
        shouldPoll: true,
      });
      this.logger.log(`Vehicle ${vehicleId} → waking`);
    } catch { /* non-fatal */ }
  }

  /**
   * Determine state from Tesla vehicle_data
   */
  private determineState(data: any): VehicleState {

    if (!data || !data.drive_state) {
      return VehicleState.OFFLINE
    }

    const driveState = data.drive_state
    const chargeState = data.charge_state
    const vehicleState = data.vehicle_state

    if (chargeState?.charging_state === 'Charging') {
      return VehicleState.CHARGING
    }

    if (driveState?.speed > 0) {
      return VehicleState.DRIVING
    }

    // SLEEPING requires idle > 10 min — is_user_present=false fires immediately after
    // the driver exits the car, but the car is still awake (PARKED) for several minutes.
    // Using the drive_state timestamp avoids misclassifying a freshly-parked car as sleeping.
    if (vehicleState?.is_user_present === false &&
      driveState?.speed === 0 &&
      chargeState?.charging_state !== 'Charging') {
      const driveTsMs = driveState?.timestamp != null
        ? new Date(driveState.timestamp * 1000).getTime()
        : null;
      const idleMinutes = driveTsMs != null ? (Date.now() - driveTsMs) / 60_000 : 0;
      if (idleMinutes > 10) {
        return VehicleState.SLEEPING;
      }
    }

    return VehicleState.PARKED
  }

  /**
   * Get current state
   */
  async getVehicleState(vehicleId: string): Promise<VehicleStateData> {

    const cached = this.vehicleStates.get(vehicleId)

    if (cached && this.isCacheFresh(cached)) {
      return cached
    }

    const state = await this.prisma.vehicleState.findUnique({
      where: { vehicleId }
    })

    if (!state) {
      return {
        state: VehicleState.PARKED,
        lastUpdate: new Date(),
        pollingInterval: this.POLLING_INTERVALS[VehicleState.PARKED],
        shouldPoll: true
      }
    }

    const stateData: VehicleStateData = {
      state: state.state as VehicleState,
      lastUpdate: state.lastUpdate,
      pollingInterval: this.POLLING_INTERVALS[state.state as VehicleState],
      shouldPoll: state.state !== VehicleState.OFFLINE
    }

    this.vehicleStates.set(vehicleId, stateData)

    return stateData
  }

  /**
   * Polling interval
   */
  async getPollingInterval(vehicleId: string): Promise<number> {
    const state = await this.getVehicleState(vehicleId)
    return state.pollingInterval
  }

  /**
   * Should poll vehicle
   */
  async shouldPollVehicle(vehicleId: string): Promise<boolean> {
    const state = await this.getVehicleState(vehicleId)
    return state.shouldPoll
  }

  /**
   * Cache freshness check
   */
  private isCacheFresh(stateData: VehicleStateData): boolean {

    const oneMinuteAgo = new Date(Date.now() - 60 * 1000)

    return stateData.lastUpdate > oneMinuteAgo
  }

  clearCache(): void {
    this.vehicleStates.clear()
    this.logger.debug('Vehicle state cache cleared')
  }

  getPollingIntervals(): Record<VehicleState, number> {
    return { ...this.POLLING_INTERVALS }
  }

  estimateDailyDataPoints(state: VehicleState): number {

    const interval = this.POLLING_INTERVALS[state]

    if (interval === 0) return 0

    const pointsPerDay = (24 * 3600) / interval

    return Math.round(pointsPerDay)
  }

  /**
   * Auto-timeout stale active states.
   *
   * Runs every 5 minutes and transitions any vehicle that has been in
   * DRIVING or CHARGING state for more than 5 minutes without a state
   * update. This prevents the dashboard showing "Едет" forever when
   * telemetry stops (vehicle parked, went to sleep, API unreachable).
   *
   *   DRIVING  → PARKED  (if lastUpdate > 5 min ago)
   *   CHARGING → PARKED  (if lastUpdate > 15 min ago — chargers can be slow to update)
   */
  @Cron('*/5 * * * *')
  async timeoutStaleActiveStates(): Promise<void> {
    if (!isWorkerRole()) return;
    const now = new Date()
    const drivingCutoff  = new Date(now.getTime() - 5  * 60_000)
    const chargingCutoff = new Date(now.getTime() - 30 * 60_000) // AC chargers can be silent 20+ min

    try {
      const stale = await this.prisma.vehicleState.findMany({
        where: {
          OR: [
            { state: VehicleState.DRIVING,  lastUpdate: { lt: drivingCutoff  } },
            { state: VehicleState.CHARGING, lastUpdate: { lt: chargingCutoff } },
          ],
        },
        select: { vehicleId: true, state: true, lastUpdate: true },
      })

      for (const row of stale) {
        const ageSec = Math.round((now.getTime() - new Date(row.lastUpdate).getTime()) / 1000)
        this.logger.warn(
          `[StateTimeout] ${row.vehicleId}: ${row.state} for ${ageSec}s → parked`,
        )
        await this.prisma.vehicleState.update({
          where: { vehicleId: row.vehicleId },
          data:  { state: VehicleState.PARKED, lastUpdate: now },
        })
        // Invalidate in-memory cache so next read reflects new state
        this.vehicleStates.delete(row.vehicleId)
      }

      if (stale.length > 0) {
        this.logger.log(`[StateTimeout] demoted ${stale.length} vehicle(s) to parked`)
      }
    } catch (e: any) {
      this.logger.warn(`timeoutStaleActiveStates error: ${e.message}`)
    }
  }

}