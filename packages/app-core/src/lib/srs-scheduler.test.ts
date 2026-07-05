import { describe, expect, it } from 'vitest'
import { newSrsState, type SrsState } from '@shared/flashcards'
import { schedule } from './srs-scheduler'

const NOW = new Date('2026-06-25T12:00:00.000Z')

describe('schedule', () => {
  it('advances a brand-new card on each rating into a scheduled state', () => {
    for (const rating of ['again', 'hard', 'good', 'easy'] as const) {
      const { srs, nextDue } = schedule(newSrsState(), rating, NOW)
      expect(srs.reps).toBe(1)
      expect(srs.state).not.toBe('new')
      expect(srs.stability).toBeGreaterThan(0)
      expect(srs.difficulty).toBeGreaterThan(0)
      expect(srs.lastReview).toBe(NOW.toISOString())
      expect(Date.parse(nextDue)).toBeGreaterThan(NOW.getTime())
    }
  })

  it('gives easier ratings longer intervals than harder ones', () => {
    const again = schedule(newSrsState(), 'again', NOW)
    const easy = schedule(newSrsState(), 'easy', NOW)
    expect(Date.parse(easy.nextDue)).toBeGreaterThan(Date.parse(again.nextDue))
    expect(easy.srs.stability!).toBeGreaterThan(again.srs.stability!)
  })

  it('lapses a mature review card when rated again', () => {
    const mature: SrsState = {
      state: 'review',
      due: new Date('2026-06-20T00:00:00.000Z').toISOString(),
      stability: 30,
      difficulty: 5,
      reps: 5,
      lapses: 1,
      lastReview: new Date('2026-05-21T00:00:00.000Z').toISOString()
    }
    const { srs } = schedule(mature, 'again', NOW)
    expect(srs.lapses).toBe(2)
    expect(srs.reps).toBe(6)
    expect(srs.state === 'relearning' || srs.state === 'review').toBe(true)
  })
})
