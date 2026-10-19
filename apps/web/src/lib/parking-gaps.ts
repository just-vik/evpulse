/** Maximum credible vampire-drain rate for a parked Tesla.
 *  Real-world max is ~2 %/h (extreme cold + Sentry). Anything above 3 %/h
 *  is a BMS-recalibration artefact or a data error. */
const MAX_DRAIN_RATE_PER_HR = 3

interface TripLike {
  id: string
  startTime: string
  endTime: string | null
  startSoc: number | null
  endSoc: number | null
}

export interface ParkingGap {
  key: string
  hours: number
  lossPct: number
  perHr: number
  afterEnd: string
  beforeStart: string
}

/**
 * Returns inter-trip SOC losses for consecutive pairs where the car was
 * parked (no charging, no anomalous rate). Gaps with charging (negative
 * lossPct) and gaps with an implausible drain rate are excluded.
 */
export function computeParkingSocGaps(trips: TripLike[]): ParkingGap[] {
  const done = trips
    .filter(t => t.endTime && t.endSoc != null && t.startSoc != null)
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())

  const out: ParkingGap[] = []
  for (let i = 0; i < done.length - 1; i++) {
    const a = done[i]
    const b = done[i + 1]
    const endA = new Date(a.endTime!).getTime()
    const startB = new Date(b.startTime).getTime()
    const hours = (startB - endA) / 3_600_000
    if (hours < 0.5 || hours > 96) continue
    const endSoc = a.endSoc!
    const startSoc = b.startSoc!
    if (endSoc < 0 || endSoc > 100 || startSoc < 0 || startSoc > 100) continue
    const lossPct = endSoc - startSoc
    if (lossPct < 0.5) continue
    const perHr = lossPct / hours
    if (perHr > MAX_DRAIN_RATE_PER_HR) continue
    out.push({ key: `${a.id}-${b.id}`, hours, lossPct, perHr, afterEnd: a.endTime!, beforeStart: b.startTime })
  }
  return out
}
