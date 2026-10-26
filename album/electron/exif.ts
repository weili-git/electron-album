/** EXIF 字段值可能是数字、分数字符串或数组，统一转成数字 */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return toNumber(value[0])
  if (typeof value !== 'string') return null

  const fraction = value.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/)
  if (fraction) {
    const denominator = Number(fraction[2])
    return denominator ? Number(fraction[1]) / denominator : null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** EXIF 时间是相机本地时间，按墙上时间构造，避免被时区平移 */
export function parseExifDate(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime()
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string') return null

  const match = value.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!match) return null

  const [, year, month, day, hour, minute, second] = match
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0)
  )
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}
