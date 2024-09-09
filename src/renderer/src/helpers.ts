/**
 * Converts a bytes size into the nearest short value
 * @param bytes input size in bytes
 * @returns string with short representation of the size
 */
export function bytesToString(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes == 0) {
    return '0.00 B'
  }
  const e = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, e)).toFixed(2)} ${' KMGTP'.charAt(e)}B`
}
