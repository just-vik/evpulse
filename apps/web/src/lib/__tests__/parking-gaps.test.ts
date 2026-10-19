import { computeParkingSocGaps } from '../parking-gaps'

function makeTrip(
  id: string,
  startIso: string,
  endIso: string,
  startSoc: number | null,
  endSoc: number | null,
) {
  return { id, startTime: startIso, endTime: endIso, startSoc, endSoc }
}

const BASE = new Date('2024-01-15T10:00:00Z')
const t = (offsetMinutes: number) => new Date(BASE.getTime() + offsetMinutes * 60_000).toISOString()

describe('computeParkingSocGaps', () => {
  it('returns empty array for a single trip', () => {
    const trips = [makeTrip('a', t(0), t(30), 80, 70)]
    expect(computeParkingSocGaps(trips)).toHaveLength(0)
  })

  it('includes a normal parking gap below rate cap', () => {
    // loss = 4%, gap = 240 min = 4 h → rate = 1 %/h (below 3 %/h cap)
    const trips = [
      makeTrip('a', t(0),   t(30),  85, 80),
      makeTrip('b', t(270), t(300), 76, 70),
    ]
    const gaps = computeParkingSocGaps(trips)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].lossPct).toBeCloseTo(4)
    expect(gaps[0].perHr).toBeCloseTo(1)
  })

  it('excludes a gap where SOC increased (charging occurred)', () => {
    const trips = [
      makeTrip('a', t(0),   t(30),  40, 40),
      makeTrip('b', t(270), t(300), 85, 80),
    ]
    expect(computeParkingSocGaps(trips)).toHaveLength(0)
  })

  it('excludes negligible loss below 0.5%', () => {
    const trips = [
      makeTrip('a', t(0),   t(30),  80, 80),
      makeTrip('b', t(270), t(300), 80, 78),
    ]
    expect(computeParkingSocGaps(trips)).toHaveLength(0)
  })

  it('excludes a gap shorter than 30 minutes', () => {
    const trips = [
      makeTrip('a', t(0),  t(20),  80, 75),
      makeTrip('b', t(40), t(60),  73, 70),
    ]
    expect(computeParkingSocGaps(trips)).toHaveLength(0)
  })

  it('excludes a gap longer than 96 hours', () => {
    const trips = [
      makeTrip('a', t(0),            t(30),            80, 75),
      makeTrip('b', t(96 * 60 + 90), t(96 * 60 + 120), 50, 45),
    ]
    expect(computeParkingSocGaps(trips)).toHaveLength(0)
  })

  it('excludes a gap with drain rate above 3 %/h (BMS artefact)', () => {
    // 20% loss in 60 min → 20 %/h — physically impossible for parked vehicle
    const trips = [
      makeTrip('a', t(0),  t(30),  80, 80),
      makeTrip('b', t(90), t(120), 60, 55),
    ]
    expect(computeParkingSocGaps(trips)).toHaveLength(0)
  })

  it('excludes trips with null SOC from pair formation', () => {
    const trips = [
      makeTrip('a', t(0),   t(30),  80, null),  // endSoc null → excluded from pairs
      makeTrip('b', t(270), t(300), 75, 70),
      makeTrip('c', t(540), t(570), 65, 60),
    ]
    const gaps = computeParkingSocGaps(trips)
    expect(gaps).toHaveLength(1)
    expect(gaps[0].key).toBe('b-c')
  })

  it('preserves chronological order in output', () => {
    const trips = [
      makeTrip('a', t(0),   t(30),  85, 80),
      makeTrip('b', t(270), t(300), 76, 70),
      makeTrip('c', t(540), t(570), 64, 60),
    ]
    const gaps = computeParkingSocGaps(trips)
    expect(gaps).toHaveLength(2)
    expect(gaps[0].key).toBe('a-b')
    expect(gaps[1].key).toBe('b-c')
  })
})
