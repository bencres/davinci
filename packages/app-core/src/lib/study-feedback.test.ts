import { describe, expect, it } from 'vitest'
import { calibrationNote, ratingToFeedbackTier } from './study-feedback'

describe('ratingToFeedbackTier', () => {
  it('treats good and easy as a win', () => {
    expect(ratingToFeedbackTier('good')).toBe('win')
    expect(ratingToFeedbackTier('easy')).toBe('win')
  })

  it('treats again and hard as soft (never a failure)', () => {
    expect(ratingToFeedbackTier('again')).toBe('soft')
    expect(ratingToFeedbackTier('hard')).toBe('soft')
  })
})

describe('calibrationNote', () => {
  it('returns null when the learner did not predict', () => {
    expect(calibrationNote(null, 'good')).toBeNull()
    expect(calibrationNote(undefined, 'again')).toBeNull()
  })

  it('celebrates a matched prediction', () => {
    expect(calibrationNote('good', 'good')).toEqual({ text: 'Predicted right ✓', tone: 'hit' })
  })

  it('flags over-confidence (predicted better than graded)', () => {
    expect(calibrationNote('easy', 'again')).toEqual({
      text: 'Predicted Easy → Again',
      tone: 'over'
    })
  })

  it('flags under-confidence (predicted worse than graded)', () => {
    expect(calibrationNote('hard', 'good')).toEqual({
      text: 'Predicted Hard → Good',
      tone: 'under'
    })
  })
})
