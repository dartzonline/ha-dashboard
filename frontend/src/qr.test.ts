import { describe, expect, it } from 'vitest'
import { qrMatrix, wifiQrPayload } from './qr'

/** Reads the 15 format bits next to the top-left finder, undoes the XOR mask, and checks the BCH code. */
function formatIsValid(matrix: boolean[][]): { valid: boolean; level: number; mask: number } {
  const bit = (x: number, y: number) => (matrix[y][x] ? 1 : 0)
  let bits = 0
  for (let i = 0; i <= 5; i++) bits |= bit(8, i) << i
  bits |= bit(8, 7) << 6
  bits |= bit(8, 8) << 7
  bits |= bit(7, 8) << 8
  for (let i = 9; i < 15; i++) bits |= bit(14 - i, 8) << i
  const raw = bits ^ 0x5412
  const data = raw >>> 10
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return { valid: ((data << 10) | rem) === raw, level: data >>> 3, mask: data & 7 }
}

describe('qrMatrix', () => {
  it('picks the smallest version that fits and is square', () => {
    expect(qrMatrix('hello').length).toBe(21) // version 1
    expect(qrMatrix('x'.repeat(14)).length).toBe(21)
    expect(qrMatrix('x'.repeat(15)).length).toBe(25) // version 2
    expect(qrMatrix('x'.repeat(200)).length).toBe(57) // version 10 holds 213 bytes
    expect(qrMatrix('x'.repeat(214)).length).toBe(61) // version 11
    for (const row of qrMatrix('WIFI:T:WPA;S:HomeNet;P:correct horse battery;;')) expect(row.length).toBe(qrMatrix('WIFI:T:WPA;S:HomeNet;P:correct horse battery;;').length)
  })

  it('draws the three finder patterns, the timing lines and the dark module', () => {
    const matrix = qrMatrix('hello world')
    const size = matrix.length
    for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3))
        expect(matrix[oy + y][ox + x], `finder at ${ox},${oy} cell ${x},${y}`).toBe(ring !== 2)
      }
    }
    for (let i = 8; i < size - 8; i++) {
      expect(matrix[6][i]).toBe(i % 2 === 0)
      expect(matrix[i][6]).toBe(i % 2 === 0)
    }
    expect(matrix[size - 8][8]).toBe(true)
  })

  it('writes valid error-correction level M format information with a real mask', () => {
    for (const text of ['a', 'hello world', 'WIFI:T:WPA;S:HomeNet;P:correct horse battery;;', 'x'.repeat(120)]) {
      const info = formatIsValid(qrMatrix(text))
      expect(info.valid, text).toBe(true)
      expect(info.level).toBe(0) // level M
      expect(info.mask).toBeGreaterThanOrEqual(0)
      expect(info.mask).toBeLessThan(8)
    }
  })

  it('is deterministic, and refuses what cannot fit', () => {
    expect(qrMatrix('same')).toEqual(qrMatrix('same'))
    expect(qrMatrix('same')).not.toEqual(qrMatrix('other'))
    expect(() => qrMatrix('x'.repeat(400))).toThrow(RangeError)
  })

  it('fits the largest Wi-Fi sign-in there can be', () => {
    const worst = wifiQrPayload({ ssid: ';'.repeat(32), password: ';'.repeat(63), security: 'WPA', hidden: true })
    expect(new TextEncoder().encode(worst).length).toBeLessThan(250)
    expect(qrMatrix(worst).length).toBeGreaterThan(21)
  })
})

describe('wifiQrPayload', () => {
  it('escapes the characters the format reserves', () => {
    expect(wifiQrPayload({ ssid: 'My "Net"; home', password: 'p@ss;w\\ord:1,2', security: 'WPA', hidden: false }))
      .toBe('WIFI:T:WPA;S:My \\"Net\\"\\; home;P:p@ss\\;w\\\\ord\\:1\\,2;;')
  })

  it('leaves out the password for an open network and flags a hidden one', () => {
    expect(wifiQrPayload({ ssid: 'Cafe', password: 'ignored', security: 'nopass', hidden: false })).toBe('WIFI:T:nopass;S:Cafe;;')
    expect(wifiQrPayload({ ssid: 'a', password: 'b', security: 'WEP', hidden: true })).toBe('WIFI:T:WEP;S:a;P:b;H:true;;')
  })
})
