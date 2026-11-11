/**
 * A small QR code encoder: byte mode, error correction level M, versions 1 to 14.
 *
 * That covers every Wi-Fi sign-in string (a 32-character name and 63-character password, both
 * fully escaped, is under 250 bytes). Written without a dependency so the wall panel's bundle has
 * nothing new to trust; checked by decoding its output with a real barcode reader (see qr.test.ts
 * for the structural checks).
 *
 * The algorithm is the standard one from ISO/IEC 18004: pad the data, split it into blocks, add
 * Reed-Solomon error correction, interleave, place the bits around the fixed patterns, then pick
 * whichever of the eight masks leaves the fewest hard-to-scan patterns.
 */

const MAX_VERSION = 14
/** Error-correction codewords per block, and number of blocks, for level M by version (index 0 unused). */
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24]
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9]
/** Level M's two format-info bits. */
const FORMAT_LEVEL_M = 0

function sizeOf(version: number) {
  return version * 4 + 17
}

function rawDataModules(version: number): number {
  const size = sizeOf(version)
  let result = size * size
  result -= 8 * 8 * 3 // three finder patterns with their separators
  result -= 15 * 2 + 1 // format information and the dark module
  result -= (size - 16) * 2 // timing patterns
  if (version >= 2) {
    const aligns = Math.floor(version / 7) + 2
    result -= (aligns - 1) * (aligns - 1) * 25
    result -= (aligns - 2) * 2 * 20
    if (version >= 7) result -= 6 * 3 * 2 // version information
  }
  return result
}

function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version]
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const aligns = Math.floor(version / 7) + 2
  const size = sizeOf(version)
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (aligns * 2 - 2)) * 2
  const positions = [6]
  for (let position = size - 7; positions.length < aligns; position -= step) positions.splice(1, 0, position)
  return positions
}

function multiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function divisor(degree: number): number[] {
  const result: number[] = new Array(degree - 1).fill(0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = multiply(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = multiply(root, 0x02)
  }
  return result
}

function remainder(data: number[], div: number[]): number[] {
  const result = div.map(() => 0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() as number)
    result.push(0)
    div.forEach((coefficient, i) => { result[i] ^= multiply(coefficient, factor) })
  }
  return result
}

function withErrorCorrection(data: number[], version: number): number[] {
  const blocks = BLOCKS[version]
  const eccLength = ECC_PER_BLOCK[version]
  const raw = Math.floor(rawDataModules(version) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLength = Math.floor(raw / blocks)
  const div = divisor(eccLength)
  const result: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1))
    k += block.length
    const ecc = remainder(block, div)
    if (i < shortBlocks) block.push(0)
    result.push(block.concat(ecc))
  }
  const interleaved: number[] = []
  for (let i = 0; i < result[0].length; i++) {
    result.forEach((block, j) => {
      // The padding slot of a short block is skipped, not emitted.
      if (i !== shortLength - eccLength || j >= shortBlocks) interleaved.push(block[i])
    })
  }
  return interleaved
}

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

function dataBits(bytes: number[], version: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  push(0b0100, 4)
  push(bytes.length, version <= 9 ? 8 : 16)
  bytes.forEach((byte) => push(byte, 8))
  const capacityBits = dataCodewords(version) * 8
  push(0, Math.min(4, capacityBits - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8)
  return bits
}

class Grid {
  readonly version: number
  readonly size: number
  readonly modules: boolean[][]
  private readonly reserved: boolean[][]

  constructor(version: number) {
    this.version = version
    this.size = sizeOf(version)
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.drawFixedPatterns()
  }

  private fixed(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark
    this.reserved[y][x] = true
  }

  private drawFixedPatterns() {
    const { size, version } = this
    for (let i = 0; i < size; i++) {
      this.fixed(6, i, i % 2 === 0)
      this.fixed(i, 6, i % 2 === 0)
    }
    this.finder(3, 3)
    this.finder(size - 4, 3)
    this.finder(3, size - 4)
    const positions = alignmentPositions(version)
    positions.forEach((x, i) => positions.forEach((y, j) => {
      const atCorner = (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0)
      if (!atCorner) this.alignment(x, y)
    }))
    this.formatBits(0)
    this.versionBits()
  }

  private finder(x: number, y: number) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.fixed(xx, yy, distance !== 2 && distance !== 4)
      }
    }
  }

  private alignment(x: number, y: number) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.fixed(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }

  formatBits(mask: number) {
    const data = (FORMAT_LEVEL_M << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const bit = (i: number) => ((bits >>> i) & 1) !== 0
    const { size } = this
    for (let i = 0; i <= 5; i++) this.fixed(8, i, bit(i))
    this.fixed(8, 7, bit(6))
    this.fixed(8, 8, bit(7))
    this.fixed(7, 8, bit(8))
    for (let i = 9; i < 15; i++) this.fixed(14 - i, 8, bit(i))
    for (let i = 0; i < 8; i++) this.fixed(size - 1 - i, 8, bit(i))
    for (let i = 8; i < 15; i++) this.fixed(8, size - 15 + i, bit(i))
    this.fixed(8, size - 8, true)
  }

  private versionBits() {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.fixed(a, b, dark)
      this.fixed(b, a, dark)
    }
  }

  placeCodewords(codewords: number[]) {
    const { size } = this
    let i = 0
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vert : vert
          if (!this.reserved[y][x] && i < codewords.length * 8) {
            this.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0
            i++
          }
        }
      }
    }
  }

  mask(pattern: number) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (this.reserved[y][x]) continue
        let flip: boolean
        switch (pattern) {
          case 0: flip = (x + y) % 2 === 0; break
          case 1: flip = y % 2 === 0; break
          case 2: flip = x % 3 === 0; break
          case 3: flip = (x + y) % 3 === 0; break
          case 4: flip = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: flip = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: flip = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: flip = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        if (flip) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  /** How hard the pattern is to scan: long runs, 2x2 blocks, finder look-alikes, and imbalance. */
  penalty(): number {
    const { size, modules } = this
    let score = 0
    const line = (read: (i: number) => boolean) => {
      let run = 1
      for (let i = 1; i < size; i++) {
        if (read(i) === read(i - 1)) {
          run++
          if (run === 5) score += 3
          else if (run > 5) score += 1
        } else run = 1
      }
      const pattern = Array.from({ length: size }, (_, i) => (read(i) ? '1' : '0')).join('')
      for (const look of ['10111010000', '00001011101']) {
        for (let at = pattern.indexOf(look); at !== -1; at = pattern.indexOf(look, at + 1)) score += 40
      }
    }
    for (let y = 0; y < size; y++) line((x) => modules[y][x])
    for (let x = 0; x < size; x++) line((y) => modules[y][x])
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y][x]
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) score += 3
      }
    }
    const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
    const total = size * size
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
    return score
  }
}

/** The QR code for `text` as rows of dark (true) and light (false) modules, without a quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = utf8(text)
  let version = 1
  const needed = (v: number) => 4 + (v <= 9 ? 8 : 16) + bytes.length * 8
  while (version <= MAX_VERSION && needed(version) > dataCodewords(version) * 8) version++
  if (version > MAX_VERSION) throw new RangeError('Too much text for a QR code here')

  const bits = dataBits(bytes, version)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0))
  const codewords = withErrorCorrection(data, version)

  const grid = new Grid(version)
  grid.placeCodewords(codewords)
  let best = 0
  let bestScore = Infinity
  for (let pattern = 0; pattern < 8; pattern++) {
    grid.mask(pattern)
    grid.formatBits(pattern)
    const score = grid.penalty()
    if (score < bestScore) { best = pattern; bestScore = score }
    grid.mask(pattern)
  }
  grid.mask(best)
  grid.formatBits(best)
  return grid.modules
}

/** What a phone expects inside the code to join a network. Backslash, semicolon, comma, colon and quote are escaped. */
export function wifiQrPayload(wifi: { ssid: string; password: string; security: 'WPA' | 'WEP' | 'nopass'; hidden: boolean }): string {
  const escape = (value: string) => value.replace(/([\\;,:"])/g, '\\$1')
  const parts = [`T:${wifi.security}`, `S:${escape(wifi.ssid)}`]
  if (wifi.security !== 'nopass') parts.push(`P:${escape(wifi.password)}`)
  if (wifi.hidden) parts.push('H:true')
  return `WIFI:${parts.join(';')};;`
}
