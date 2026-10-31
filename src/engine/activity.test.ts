import { describe, expect, it } from 'vitest'
import { ActivityLog } from './activity'

describe('activity', () => {
  it('keeps the last 1,000 events; a batch never carries the ones that left', () => {
    const log = new ActivityLog()
    for (let i = 0; i < 5000; i++) log.add({ name: `f${i}.jpg`, outcome: 'linked' })
    const batch = log.takeChanged()
    expect(batch).toHaveLength(1000)
    expect(batch[0].name).toBe('f4000.jpg')
    expect(batch.at(-1)?.name).toBe('f4999.jpg')
    expect(log.recent().map(e => e.name)).toEqual(batch.map(e => e.name))
    expect(log.recent(3).map(e => e.name)).toEqual(['f4997.jpg', 'f4998.jpg', 'f4999.jpg'])
    // An entry that left is not updated, nor sent again
    log.update(batch[0].id - 1, { outcome: 'failed' })
    expect(log.takeChanged()).toEqual([])
  })

  it('a batch carries what changed since the last one, oldest first, progress only in steps', () => {
    const log = new ActivityLog()
    const a = log.add({ name: 'a.jpg', outcome: 'downloading', progress: 0 })
    const b = log.add({ name: 'b.jpg', outcome: 'downloading', progress: 0 })
    expect(log.takeChanged().map(e => e.name)).toEqual(['a.jpg', 'b.jpg'])
    log.update(b.id, { progress: 0.01 })
    expect(log.takeChanged()).toEqual([])
    log.update(b.id, { progress: 0.5 })
    log.update(a.id, { outcome: 'downloaded', progress: undefined })
    expect(log.takeChanged().map(e => [e.name, e.outcome])).toEqual([
      ['a.jpg', 'downloaded'],
      ['b.jpg', 'downloading'],
    ])
    for (let i = 0; i < 1500; i++) log.add({ name: `n${i}.jpg`, outcome: 'linked' })
    // a.jpg and b.jpg left the last 1,000: an update of theirs is not sent
    log.update(a.id, { outcome: 'failed' })
    expect(log.takeChanged().map(e => e.name)).not.toContain('a.jpg')
    expect(log.recent()).toHaveLength(1000)
  })
})
