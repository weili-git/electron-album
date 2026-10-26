import { app } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import exifr from 'exifr'
import type { AlbumStats, StatsBucket } from '../shared/types'
import { parseExifDate, toNumber } from './exif'
import { photoId, type PhotoFile } from './photos'
import { mapLimit } from './util'

const CACHE_VERSION = 1
/** EXIF 读取以 I/O 为主，控制并发避免和缩略图生成抢资源 */
const READ_CONCURRENCY = 4
const PROGRESS_INTERVAL_MS = 150

/** 统计只需要这几个字段，避免解析厂商私有的大块数据 */
const EXIF_FIELDS = [
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'FNumber',
  'ExposureTime',
  'ISO',
  'ISOSpeedRatings',
  'DateTimeOriginal',
  'CreateDate'
]

/** 一张照片中参与统计的字段；缺失值为 null */
export interface StatsFields {
  takenAt: number | null
  focalLength: number | null
  focalLength35: number | null
  aperture: number | null
  shutterSeconds: number | null
  iso: number | null
}

interface CachedStatsEntry extends StatsFields {
  /** 与原文件对比，文件变化后自动失效 */
  mtimeMs: number
  size: number
}

interface CacheFile {
  version: number
  entries: Record<string, CachedStatsEntry>
}

interface AlbumCache {
  entries: Map<string, CachedStatsEntry>
  dirty: boolean
}

export type StatsProgressCallback = (processed: number, total: number) => void

/** 按相册分文件缓存，避免启动时解析整个库的 EXIF */
const caches = new Map<string, AlbumCache>()
let writeSequence = 0

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'exif-cache')
}

function cacheFile(albumId: string): string {
  return path.join(cacheDir(), `${albumId}.json`)
}

function isFiniteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isCachedEntry(value: unknown): value is CachedStatsEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.mtimeMs === 'number' &&
    Number.isFinite(entry.mtimeMs) &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size) &&
    isFiniteOrNull(entry.takenAt) &&
    isFiniteOrNull(entry.focalLength) &&
    isFiniteOrNull(entry.focalLength35) &&
    isFiniteOrNull(entry.aperture) &&
    isFiniteOrNull(entry.shutterSeconds) &&
    isFiniteOrNull(entry.iso)
  )
}

async function loadCache(albumId: string): Promise<AlbumCache> {
  const existing = caches.get(albumId)
  if (existing) return existing

  const cache: AlbumCache = { entries: new Map(), dirty: false }
  caches.set(albumId, cache)

  try {
    const raw = await fs.readFile(cacheFile(albumId), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CacheFile>
    if (parsed.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
      for (const [id, entry] of Object.entries(parsed.entries)) {
        if (isCachedEntry(entry)) cache.entries.set(id, entry)
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn('[exif-stats] failed to load cache:', albumId, error)
    }
  }

  return cache
}

/** 保存时顺带清掉已不在相册里的照片，避免缓存无限增长 */
async function saveCache(albumId: string, validIds: Set<string>): Promise<void> {
  const cache = caches.get(albumId)
  if (!cache) return

  for (const id of cache.entries.keys()) {
    if (!validIds.has(id)) {
      cache.entries.delete(id)
      cache.dirty = true
    }
  }
  if (!cache.dirty) return

  cache.dirty = false
  const entries: Record<string, CachedStatsEntry> = {}
  for (const [id, entry] of cache.entries) entries[id] = entry
  const serialized = JSON.stringify({ version: CACHE_VERSION, entries } satisfies CacheFile)

  try {
    const file = cacheFile(albumId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tempFile = `${file}.${process.pid}.${writeSequence++}.tmp`
    await fs.writeFile(tempFile, serialized, 'utf8')
    await fs.rename(tempFile, file)
  } catch (error) {
    cache.dirty = true
    console.warn('[exif-stats] failed to save cache:', albumId, error)
  }
}

/** 退出时同步落盘，保留已经读取的统计结果 */
export function flushExifCacheSync(): void {
  for (const [albumId, cache] of caches) {
    if (!cache.dirty) continue
    cache.dirty = false

    try {
      const entries: Record<string, CachedStatsEntry> = {}
      for (const [id, entry] of cache.entries) entries[id] = entry
      const file = cacheFile(albumId)
      fsSync.mkdirSync(path.dirname(file), { recursive: true })
      const tempFile = `${file}.${process.pid}.${writeSequence++}.tmp`
      fsSync.writeFileSync(
        tempFile,
        JSON.stringify({ version: CACHE_VERSION, entries } satisfies CacheFile),
        'utf8'
      )
      fsSync.renameSync(tempFile, file)
    } catch (error) {
      cache.dirty = true
      console.warn('[exif-stats] failed to save cache on quit:', albumId, error)
    }
  }
}

/** 从相册库移除时清掉对应的统计缓存 */
export function removeAlbumExifCache(albumId: string): void {
  caches.delete(albumId)
  void fs.rm(cacheFile(albumId), { force: true }).catch(() => undefined)
}

const EMPTY_FIELDS: StatsFields = {
  takenAt: null,
  focalLength: null,
  focalLength35: null,
  aperture: null,
  shutterSeconds: null,
  iso: null
}

function positiveNumber(value: unknown): number | null {
  const parsed = toNumber(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

async function readStatsFields(file: PhotoFile): Promise<StatsFields> {
  let exif: Record<string, unknown> | null = null
  try {
    const parsed = await exifr.parse(file.path, {
      pick: EXIF_FIELDS,
      translateValues: false,
      reviveValues: false
    })
    exif = (parsed as Record<string, unknown> | undefined) ?? null
  } catch {
    // 单张读取失败按“没有拍摄信息”处理，不阻塞整本相册的统计
  }

  if (!exif) return EMPTY_FIELDS

  return {
    takenAt: parseExifDate(exif.DateTimeOriginal) ?? parseExifDate(exif.CreateDate),
    focalLength: positiveNumber(exif.FocalLength),
    focalLength35: positiveNumber(exif.FocalLengthIn35mmFormat),
    aperture: positiveNumber(exif.FNumber),
    shutterSeconds: positiveNumber(exif.ExposureTime),
    iso: positiveNumber(exif.ISO) ?? positiveNumber(exif.ISOSpeedRatings)
  }
}

/**
 * 逐张读取（命中缓存则跳过）并汇总相册统计。
 * 返回前会把缓存写入磁盘；进度回调已按时间节流。
 */
export async function computeAlbumStats(
  albumId: string,
  photos: PhotoFile[],
  onProgress: StatsProgressCallback
): Promise<AlbumStats> {
  const cache = await loadCache(albumId)
  const ids = photos.map((photo) => photoId(photo.path))
  const total = photos.length
  const fields = new Array<StatsFields>(total)

  let processed = 0
  let lastReport = 0
  const report = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return
    lastReport = now
    onProgress(processed, total)
  }
  report(true)

  await mapLimit(photos, READ_CONCURRENCY, async (photo, index) => {
    const id = ids[index]
    const cached = cache.entries.get(id)

    if (cached && cached.mtimeMs === photo.mtimeMs && cached.size === photo.size) {
      fields[index] = cached
    } else {
      const entry: CachedStatsEntry = {
        mtimeMs: photo.mtimeMs,
        size: photo.size,
        ...(await readStatsFields(photo))
      }
      cache.entries.set(id, entry)
      cache.dirty = true
      fields[index] = entry
    }

    processed += 1
    report()
  })

  report(true)
  await saveCache(albumId, new Set(ids))
  return aggregateStats(total, fields)
}

interface FocalBin {
  max: number
  label: string
}

const FOCAL_BINS: FocalBin[] = [
  { max: 20, label: '≤ 20 mm' },
  { max: 35, label: '21–35 mm' },
  { max: 50, label: '36–50 mm' },
  { max: 85, label: '51–85 mm' },
  { max: 135, label: '86–135 mm' },
  { max: 200, label: '136–200 mm' },
  { max: 400, label: '201–400 mm' },
  { max: Number.POSITIVE_INFINITY, label: '> 400 mm' }
]

interface ShutterBin {
  min: number
  label: string
}

/** 从慢到快排列，边界值归入较慢的一档 */
const SHUTTER_BINS: ShutterBin[] = [
  { min: 1, label: '≥ 1 s' },
  { min: 1 / 2, label: '1/2–1 s' },
  { min: 1 / 4, label: '1/4–1/2 s' },
  { min: 1 / 8, label: '1/8–1/4 s' },
  { min: 1 / 15, label: '1/15–1/8 s' },
  { min: 1 / 30, label: '1/30–1/15 s' },
  { min: 1 / 60, label: '1/60–1/30 s' },
  { min: 1 / 125, label: '1/125–1/60 s' },
  { min: 1 / 250, label: '1/250–1/125 s' },
  { min: 1 / 500, label: '1/500–1/250 s' },
  { min: 1 / 1000, label: '1/1000–1/500 s' },
  { min: Number.NEGATIVE_INFINITY, label: '< 1/1000 s' }
]

function bump<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function hasShootingInfo(field: StatsFields): boolean {
  return (
    field.takenAt !== null ||
    field.focalLength !== null ||
    field.focalLength35 !== null ||
    field.aperture !== null ||
    field.shutterSeconds !== null ||
    field.iso !== null
  )
}

function binBuckets(keys: string[], counts: Map<string, number>): StatsBucket[] {
  const buckets: StatsBucket[] = []
  for (const label of keys) {
    const count = counts.get(label)
    if (count) buckets.push({ label, count })
  }
  return buckets
}

function sortedNumberBuckets(
  counts: Map<number, number>,
  format: (value: number) => string
): StatsBucket[] {
  return Array.from(counts.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([value, count]) => ({ label: format(value), count }))
}

function sortedStringBuckets(counts: Map<string, number>): StatsBucket[] {
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, count]) => ({ label, count }))
}

/** 纯函数：把逐张 EXIF 字段汇总成渲染进程使用的统计结构 */
export function aggregateStats(photoCount: number, fields: StatsFields[]): AlbumStats {
  let withExif = 0
  let firstTakenAt: number | null = null
  let lastTakenAt: number | null = null
  const focalCounts = new Map<string, number>()
  const apertureCounts = new Map<number, number>()
  const shutterCounts = new Map<string, number>()
  const isoCounts = new Map<number, number>()
  const monthCounts = new Map<string, number>()
  const hourCounts = new Map<number, number>()

  for (const field of fields) {
    if (!hasShootingInfo(field)) continue
    withExif += 1

    if (field.takenAt !== null) {
      if (firstTakenAt === null || field.takenAt < firstTakenAt) firstTakenAt = field.takenAt
      if (lastTakenAt === null || field.takenAt > lastTakenAt) lastTakenAt = field.takenAt

      // EXIF 时间按相机本地墙上时间构造，这里直接取本地年月/小时
      const date = new Date(field.takenAt)
      bump(monthCounts, `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`)
      bump(hourCounts, date.getHours())
    }

    const focal = field.focalLength35 ?? field.focalLength
    if (focal !== null) {
      const rounded = Math.round(focal)
      const bin = FOCAL_BINS.find((item) => rounded <= item.max) ?? FOCAL_BINS[FOCAL_BINS.length - 1]
      bump(focalCounts, bin.label)
    }

    if (field.aperture !== null) {
      bump(apertureCounts, Math.round(field.aperture * 10) / 10)
    }

    if (field.shutterSeconds !== null) {
      const bin =
        SHUTTER_BINS.find((item) => field.shutterSeconds !== null && field.shutterSeconds >= item.min) ??
        SHUTTER_BINS[SHUTTER_BINS.length - 1]
      bump(shutterCounts, bin.label)
    }

    if (field.iso !== null) {
      bump(isoCounts, Math.round(field.iso))
    }
  }

  return {
    photoCount,
    withExif,
    firstTakenAt,
    lastTakenAt,
    focalLengths: binBuckets(
      FOCAL_BINS.map((item) => item.label),
      focalCounts
    ),
    apertures: sortedNumberBuckets(apertureCounts, (value) => `f/${value}`),
    shutterSpeeds: binBuckets(
      SHUTTER_BINS.map((item) => item.label),
      shutterCounts
    ),
    isos: sortedNumberBuckets(isoCounts, (value) => String(value)),
    months: sortedStringBuckets(monthCounts),
    hours: sortedNumberBuckets(hourCounts, (value) => `${String(value).padStart(2, '0')}:00`)
  }
}
