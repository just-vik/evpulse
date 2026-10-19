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

  it('excludes gaps with out-of-range SOC values', () => {
    // endSoc > 100 is a data error (BMS reporting artefact)
    const trips = [
      makeTrip('a', t(0),   t(30),  85, 150),  // endSoc = 150 — invalid
      makeTrip('b', t(270), t(300), 76,  70),
    ]
    expect(computeParkingSocGaps(trips)).toHaveLength(0)

    // startSoc < 0 is also invalid
    const trips2 = [
      makeTrip('x', t(0),   t(30),  85,  80),
      makeTrip('y', t(270), t(300), -5,  70),  // startSoc = -5 — invalid
    ]
    expect(computeParkingSocGaps(trips2)).toHaveLength(0)
  })

  it('excludes a gap with zero or negative duration', () => {
    // trips with identical or reversed timestamps produce hours ≤ 0 → < 0.5 → excluded
    const trips = [
      makeTrip('a', t(0),   t(60),  80, 75),
      makeTrip('b', t(60),  t(90),  74, 70),   // gap = 0 min exactly
    ]
    expect(computeParkingSocGaps(trips)).toHaveLength(0)

    const tripsOverlap = [
      makeTrip('c', t(0),   t(90),  80, 75),
      makeTrip('d', t(60),  t(120), 74, 70),   // startD < endC → negative gap
    ]
    expect(computeParkingSocGaps(tripsOverlap)).toHaveLength(0)
  })

  it('computes duration-weighted avgPerHr correctly across gaps of different length', () => {
    // gap a→b: 5% over 5h = 1.0 %/h
    // gap b→c: 4% over 8h = 0.5 %/h
    // weighted avg = (5+4)/(5+8) = 9/13 ≈ 0.692 %/h
    const trips = [
      makeTrip('a', t(0),    t(30),   80, 75),   // endSoc = 75
      makeTrip('b', t(330),  t(360),  70, 65),   // gap = 300 min = 5h, startSoc=70 → loss=5%
      makeTrip('c', t(840),  t(870),  61, 55),   // gap = 480 min = 8h, startSoc=61 → loss=4%
    ]
    const gaps = computeParkingSocGaps(trips)
    expect(gaps).toHaveLength(2)
    // verify individual measurements
    expect(gaps[0].lossPct).toBeCloseTo(5)
    expect(gaps[0].perHr).toBeCloseTo(1.0)
    expect(gaps[1].lossPct).toBeCloseTo(4)
    expect(gaps[1].perHr).toBeCloseTo(0.5)
    // caller is responsible for weighted average — verify the inputs are correct
    const totalLoss = gaps.reduce((s, g) => s + g.lossPct, 0)
    const totalHours = gaps.reduce((s, g) => s + g.hours, 0)
    const avgPerHr = totalLoss / totalHours
    expect(avgPerHr).toBeCloseTo(9 / 13)
  })

  it('returns empty array and no NaN when all gaps are filtered', () => {
    // every gap is above the rate cap → all excluded
    const trips = [
      makeTrip('a', t(0),  t(30),  80, 80),
      makeTrip('b', t(90), t(120), 50, 45),   // 30% in 1h = 30 %/h
      makeTrip('c', t(180), t(210), 20, 15),  // 30% in 1h = 30 %/h
    ]
    const gaps = computeParkingSocGaps(trips)
    expect(gaps).toHaveLength(0)
    // caller-side avgPerHr should be guarded: totalHours=0 → no division by zero
    const totalHours = gaps.reduce((s, g) => s + g.hours, 0)
    const avgPerHr = totalHours > 0 ? gaps.reduce((s, g) => s + g.lossPct, 0) / totalHours : 0
    expect(Number.isNaN(avgPerHr)).toBe(false)
    expect(avgPerHr).toBe(0)
  })
})
