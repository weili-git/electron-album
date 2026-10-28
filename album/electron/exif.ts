import exifr from 'exifr'

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

/** 清理 EXIF 字符串：去掉尾部的 NUL、首尾空白；空串视为缺失 */
export function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\0+$/, '').trim()
  return trimmed || null
}

/** 拼接相机 Make + Model；Model 已包含品牌时不再重复 */
export function joinCamera(make: string | null, model: string | null): string | null {
  if (!make) return model
  if (!model) return make
  const brand = make.split(/\s+/)[0]?.toLowerCase()
  return brand && model.toLowerCase().includes(brand) ? model : `${make} ${model}`
}

/** 过滤相机/镜头字段里的占位值 */
export function usefulGearName(value: string | null): string | null {
  if (!value) return null
  if (/^(unknown|n\/?a|none|-+|0+)$/i.test(value.trim())) return null
  return value
}

export interface GearExif {
  camera: string | null
  lens: string | null
}

/**
 * 读取设备库需要的机身与镜头信息。
 * 设备库抽样和相似分析补读共用同一套字段与归一化规则。
 */
export async function readGearExif(filePath: string): Promise<GearExif> {
  const parsed = await exifr.parse(filePath, {
    pick: ['Make', 'Model', 'LensModel'],
    translateValues: false,
    reviveValues: false
  })
  const exif = (parsed as Record<string, unknown> | undefined) ?? null
  const make = cleanString(exif?.Make)
  const model = cleanString(exif?.Model)
  // 只有品牌、没有型号时不足以区分机身，按未识别处理
  return {
    camera: usefulGearName(model ? joinCamera(make, model) : null),
    lens: usefulGearName(cleanString(exif?.LensModel))
  }
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
