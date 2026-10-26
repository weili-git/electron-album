import path from 'node:path'
import exifr from 'exifr'
import sharp from 'sharp'
import type { PhotoDetails } from '../shared/types'
import { parseExifDate, toNumber } from './exif'
import type { PhotoFile } from './photos'

/** 只解析需要的字段，避免读取庞大的厂商私有信息 */
const EXIF_FIELDS = [
  'Make',
  'Model',
  'LensModel',
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'FNumber',
  'ExposureTime',
  'ExposureBiasValue',
  'ISO',
  'ISOSpeedRatings',
  'DateTimeOriginal',
  'CreateDate',
  'Orientation',
  'ImageWidth',
  'ImageHeight',
  'ExifImageWidth',
  'ExifImageHeight'
]

const CACHE_LIMIT = 300
const FORMAT_NAMES: Record<string, string> = { JPG: 'JPEG', TIF: 'TIFF' }

/** key 包含 mtime 与大小，文件变化后自动失效 */
const cache = new Map<string, PhotoDetails>()

export async function readPhotoDetails(file: PhotoFile): Promise<PhotoDetails> {
  const key = `${file.path}|${file.mtimeMs}|${file.size}`
  const cached = cache.get(key)
  if (cached) {
    // 触碰一次，维持 LRU 顺序
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const details = await extractDetails(file)
  cache.set(key, details)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return details
}

async function extractDetails(file: PhotoFile): Promise<PhotoDetails> {
  let exif: Record<string, unknown> | null = null
  try {
    const parsed = await exifr.parse(file.path, {
      pick: EXIF_FIELDS,
      translateValues: false,
      reviveValues: false
    })
    exif = (parsed as Record<string, unknown> | undefined) ?? null
  } catch (error) {
    console.warn('[photo-info] 无法读取 EXIF:', file.path, error)
  }

  let orientation = toNumber(exif?.Orientation) ?? 1
  let width = toNumber(exif?.ExifImageWidth) ?? toNumber(exif?.ImageWidth)
  let height = toNumber(exif?.ExifImageHeight) ?? toNumber(exif?.ImageHeight)

  if (width === null || height === null) {
    const meta = await readSharpMetadata(file.path)
    if (meta) {
      width = meta.width
      height = meta.height
      if (orientation === 1 && meta.orientation !== null) orientation = meta.orientation
    }
  }

  // 5–8 表示需要旋转 90°/270°，展示尺寸也要跟着交换
  if (width !== null && height !== null && orientation >= 5 && orientation <= 8) {
    ;[width, height] = [height, width]
  }

  const rawFormat = path.extname(file.path).slice(1).toUpperCase()
  const make = cleanString(exif?.Make)
  const model = cleanString(exif?.Model)

  return {
    width,
    height,
    format: FORMAT_NAMES[rawFormat] ?? rawFormat,
    sizeBytes: file.size,
    modifiedAt: file.mtimeMs,
    takenAt: parseExifDate(exif?.DateTimeOriginal) ?? parseExifDate(exif?.CreateDate),
    camera: joinCamera(make, model),
    lens: cleanString(exif?.LensModel),
    focalLength: toNumber(exif?.FocalLength),
    focalLength35: toNumber(exif?.FocalLengthIn35mmFormat),
    aperture: toNumber(exif?.FNumber),
    shutterSeconds: toNumber(exif?.ExposureTime),
    iso: toNumber(exif?.ISO) ?? toNumber(exif?.ISOSpeedRatings),
    exposureBias: toNumber(exif?.ExposureBiasValue)
  }
}

async function readSharpMetadata(
  filePath: string
): Promise<{ width: number | null; height: number | null; orientation: number | null } | null> {
  // sharp 无法解码 NEF，直接跳过
  if (path.extname(filePath).toLowerCase() === '.nef') return null
  try {
    const meta = await sharp(filePath).metadata()
    return {
      width: meta.width ?? null,
      height: meta.height ?? null,
      orientation: meta.orientation ?? null
    }
  } catch {
    return null
  }
}

function joinCamera(make: string | null, model: string | null): string | null {
  if (!make) return model
  if (!model) return make
  const brand = make.split(/\s+/)[0]?.toLowerCase()
  return brand && model.toLowerCase().includes(brand) ? model : `${make} ${model}`
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replace(/\0+$/, '').trim()
  return trimmed || null
}

