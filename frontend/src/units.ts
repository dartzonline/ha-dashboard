/**
 * Unit conversions and number formatting shared by every surface that shows a reading.
 *
 * The router reports throughput in KiB/s. Several places converted with `x 8 / 1024`, which is
 * KiB/s -> Mibit/s and understates by ~2.4%; Mbps is decimal, so it is `x 8 x 1024 / 1e6`.
 */

/** Bytes represented by one unit of each throughput unit Home Assistant integrations use. */
const BYTES_PER_UNIT: Record<string, number> = {
  'B/s': 1,
  'kB/s': 1_000,
  'KB/s': 1_000,
  'KiB/s': 1_024,
  'MB/s': 1_000_000,
  'MiB/s': 1_048_576,
  'GB/s': 1_000_000_000,
  'GiB/s': 1_073_741_824,
}

/** Bits represented by one unit of each bit-rate unit. */
const BITS_PER_UNIT: Record<string, number> = {
  'bit/s': 1,
  'kbit/s': 1_000,
  'kbps': 1_000,
  'Kbps': 1_000,
  'Mbit/s': 1_000_000,
  'Mbps': 1_000_000,
  'Gbit/s': 1_000_000_000,
  'Gbps': 1_000_000_000,
}

export const KIB_PER_SEC_TO_MBPS = (8 * 1_024) / 1_000_000

export function isThroughputUnit(unit: string | null | undefined) {
  return Boolean(unit) && (unit! in BYTES_PER_UNIT || unit! in BITS_PER_UNIT)
}

/**
 * Converts a throughput reading to megabits per second. Unknown units are assumed to already be
 * Mbps, so a sensor that publishes no unit passes through unchanged.
 */
export function toMbps(value: number, unit: string | null | undefined): number {
  if (!unit) return value
  const bytes = BYTES_PER_UNIT[unit]
  if (bytes !== undefined) return (value * bytes * 8) / 1_000_000
  const bits = BITS_PER_UNIT[unit]
  if (bits !== undefined) return (value * bits) / 1_000_000
  return value
}

/** The unit to print after a value that went through `toMbps`. */
export function displayUnit(unit: string) {
  return isThroughputUnit(unit) ? 'Mbps' : unit
}

export function formatNumber(value: number, maximumFractionDigits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value)
}
