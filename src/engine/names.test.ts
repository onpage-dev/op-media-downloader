import { describe, expect, it } from 'vitest'
import { isSafeToken, nameKey, resolveNames, sanitizeName } from './names'
import { RemoteFileTuple, RemoteIndex } from './remote-index'

function index(
  resources: [number, [number, RemoteFileTuple[]][]][],
): RemoteIndex {
  return {
    schema_id: 1,
    signature: 's',
    checkpoint: new Date().toISOString(),
    resources: resources.map(([id, things]) => ({
      id,
      things: new Map(things),
    })),
  }
}

describe('sanitizeName', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeName('Prodotto 12 - vista frontale.jpg')).toBe(
      'Prodotto 12 - vista frontale.jpg',
    )
    expect(sanitizeName('àèìòù ñ 漢字.png')).toBe('àèìòù ñ 漢字.png')
  })

  it('never lets a name leave the folder', () => {
    expect(sanitizeName('../../etc/passwd')).toBe('.._.._etc_passwd')
    expect(sanitizeName('..\\..\\Windows\\win.ini')).toBe(
      '.._.._Windows_win.ini',
    )
    expect(sanitizeName('..')).toBe('_')
    expect(sanitizeName('.')).toBe('_')
    expect(sanitizeName('')).toBe('_')
  })

  it('replaces characters Windows refuses', () => {
    expect(sanitizeName('a<b>c:d"e|f?g*h.jpg')).toBe('a_b_c_d_e_f_g_h.jpg')
    expect(sanitizeName('tab\there\u0001.txt')).toBe('tab_here_.txt')
  })

  it('drops trailing dots and spaces', () => {
    expect(sanitizeName('foto.jpg. . ')).toBe('foto.jpg')
    expect(sanitizeName('cartella...')).toBe('cartella')
  })

  it('avoids reserved device names', () => {
    expect(sanitizeName('CON')).toBe('_CON')
    expect(sanitizeName('con.txt')).toBe('_con.txt')
    expect(sanitizeName('LPT1.tar.gz')).toBe('_LPT1.tar.gz')
    expect(sanitizeName('COM10.txt')).toBe('COM10.txt')
    expect(sanitizeName('console.txt')).toBe('console.txt')
  })

  it('never takes the name of the data folder', () => {
    expect(sanitizeName('data')).toBe('_data')
    expect(sanitizeName('DATA')).toBe('_DATA')
    expect(sanitizeName('data.jpg')).toBe('data.jpg')
  })

  it('shortens long names keeping the extension', () => {
    const long = 'x'.repeat(400) + '.jpeg'
    const short = sanitizeName(long)
    expect(Buffer.byteLength(short)).toBeLessThanOrEqual(200)
    expect(short.endsWith('.jpeg')).toBe(true)
    const accents = 'è'.repeat(300) + '.pdf'
    expect(Buffer.byteLength(sanitizeName(accents))).toBeLessThanOrEqual(200)
  })

  it('is stable: a safe name stays the same', () => {
    for (const name of ['a.jpg', '_CON', '.._x', 'foto (1).png'])
      expect(sanitizeName(sanitizeName(name))).toBe(sanitizeName(name))
  })
})

describe('tokens', () => {
  it('accepts plain tokens only', () => {
    expect(isSafeToken('3f2a9c')).toBe(true)
    expect(isSafeToken('3f2a9c.png')).toBe(true)
    expect(isSafeToken('../x')).toBe(false)
    expect(isSafeToken('a/b')).toBe(false)
    expect(isSafeToken('.lock')).toBe(false)
    expect(isSafeToken('abc.download')).toBe(false)
    expect(isSafeToken('')).toBe(false)
  })
})

describe('resolveNames', () => {
  it('keeps the first file of a name, case-insensitively, in a fixed order', () => {
    const resolved = resolveNames(
      index([
        [
          1,
          [
            // Inserted out of order on purpose: things are sorted by id
            [20, [[12, null, 'Foto.JPG', 'tok-b', 20, null, null]]],
            [10, [[12, null, 'foto.jpg', 'tok-a', 10, 800, 600]]],
          ],
        ],
      ]),
    )
    expect(resolved.desired).toHaveLength(1)
    expect(resolved.desired[0]).toMatchObject({
      local_name: 'foto.jpg',
      token: 'tok-a',
    })
    expect(resolved.duplicates).toHaveLength(1)
    expect(
      resolved.duplicates[0].variants.map(v => [v.token, v.chosen]),
    ).toEqual([
      ['tok-a', true],
      ['tok-b', false],
    ])
  })

  it('a name used twice for the same content is not a duplicate', () => {
    const resolved = resolveNames(
      index([
        [
          1,
          [
            [1, [[12, null, 'a.jpg', 'tok', 1, null, null]]],
            [2, [[12, null, 'A.jpg', 'tok', 1, null, null]]],
          ],
        ],
      ]),
    )
    expect(resolved.desired).toHaveLength(1)
    expect(resolved.duplicates).toHaveLength(0)
  })

  it('one content under two names gives two names with one token', () => {
    const resolved = resolveNames(
      index([
        [
          1,
          [
            [
              1,
              [
                [12, null, 'a.jpg', 'tok', 1, null, null],
                [13, null, 'b.jpg', 'tok', 1, null, null],
              ],
            ],
          ],
        ],
      ]),
    )
    expect(resolved.desired.map(d => [d.local_name, d.token])).toEqual([
      ['a.jpg', 'tok'],
      ['b.jpg', 'tok'],
    ])
  })

  it('names that collide after cleaning are duplicates', () => {
    const resolved = resolveNames(
      index([
        [
          1,
          [
            [
              1,
              [
                [12, null, 'a:b.jpg', 't1', 1, null, null],
                [12, null, 'a_b.jpg', 't2', 1, null, null],
              ],
            ],
          ],
        ],
      ]),
    )
    expect(resolved.desired).toHaveLength(1)
    expect(resolved.desired[0].local_name).toBe('a_b.jpg')
    expect(resolved.renamed).toBe(1)
    expect(resolved.duplicates).toHaveLength(1)
  })

  it('files with an unsafe token are set apart', () => {
    const resolved = resolveNames(
      index([[1, [[1, [[12, null, 'x.jpg', '../evil', 1, null, null]]]]]]),
    )
    expect(resolved.desired).toHaveLength(0)
    expect(resolved.invalid).toHaveLength(1)
  })

  it('resources keep their schema order over thing ids', () => {
    const resolved = resolveNames(
      index([
        [2, [[1, [[22, null, 'x.pdf', 'from-res-2', 1, null, null]]]]],
        [1, [[1, [[12, null, 'x.pdf', 'from-res-1', 1, null, null]]]]],
      ]),
    )
    expect(resolved.desired[0].token).toBe('from-res-2')
  })

  it('normalises to NFC for the key', () => {
    expect(nameKey('caffè.jpg')).toBe(nameKey('caffè.jpg'))
  })
})
