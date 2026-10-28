import { app } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import type { GearAlbumInfo, GearDevice, GearSnapshot, StatsBucket } from '../shared/types'
import { readGearExif } from './exif'
import {
  getAlbumSampleSource,
  photoId,
  registerAlbumSample,
  type AlbumSampleSource
} from './photos'
import { getCachedGearInfo } from './similarity'
import { mapLimit, normalizePath } from './util'

/**
 * 拍摄设备库：假设一个相册基本由同一台机身拍摄，只读取前 3 张参考照片；
 * 样本缺失、冲突或不足时再按 25/50/75/100% 位置扩展到最多 7 张。
 * 结论按相册缓存在 userData/gear-cache.json，不在启动时预读。
 */

export interface GearAlbumRecord {
  id: string
  path: string
  name: string
}

export interface GearSample {
  /** 照片在相册默认排序中的下标 */
  index: number
  /** 照片 id（规范化路径的 sha1），用于校验样本是否仍指向同一文件 */
  id: string
  mtimeMs: number
  size: number
  createdAt: number
  camera: string | null
  lens: string | null
}

interface GearCacheEntry {
  albumId: string
  path: string
  photoCount: number
  sampleVersion: number
  checkedAt: number
  sample: GearSample[]
}

interface GearCacheFile {
  version: number
  entries: GearCacheEntry[]
}

interface AlbumSummary {
  info: GearAlbumInfo
  lensCounts: Map<string, number>
}

export type GearSnapshotListener = (snapshot: GearSnapshot) => void

const CACHE_VERSION = 1
const SAMPLE_VERSION = 1
const INITIAL_SAMPLE = 3
const MAX_SAMPLE = 7
const WRITE_DEBOUNCE_MS = 500
const SNAPSHOT_INTERVAL_MS = 250
const VALIDATE_CONCURRENCY = 4
const SAMPLE_CONCURRENCY = 3
/** 每台设备保留的镜头数上限；UI 默认只展开前 3 支，其余折叠 */
const DEVICE_LENS_LIMIT = 12

let entries = new Map<string, GearCacheEntry>()
let loaded = false
let dirty = false
let writeTimer: ReturnType<typeof setTimeout> | null = null
let writeQueue: Promise<void> = Promise.resolve()
/** 异步写入与退出时的同步写入可能重叠，用独立临时文件避免互相干扰 */
let writeSequence = 0

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'gear-cache.json')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isGearSample(value: unknown): value is GearSample {
  if (!value || typeof value !== 'object') return false
  const sample = value as Record<string, unknown>
  return (
    isFiniteNumber(sample.index) &&
    Number.isInteger(sample.index) &&
    sample.index >= 0 &&
    typeof sample.id === 'string' &&
    sample.id.length > 0 &&
    isFiniteNumber(sample.mtimeMs) &&
    isFiniteNumber(sample.size) &&
    isFiniteNumber(sample.createdAt) &&
    (sample.camera === null || typeof sample.camera === 'string') &&
    (sample.lens === null || typeof sample.lens === 'string')
  )
}

function isGearCacheEntry(value: unknown): value is GearCacheEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.albumId === 'string' &&
    entry.albumId.length > 0 &&
    typeof entry.path === 'string' &&
    entry.path.length > 0 &&
    isFiniteNumber(entry.photoCount) &&
    isFiniteNumber(entry.sampleVersion) &&
    isFiniteNumber(entry.checkedAt) &&
    Array.isArray(entry.sample) &&
    entry.sample.every(isGearSample)
  )
}

export async function loadGearCache(): Promise<void> {
  if (loaded) return
  loaded = true

  try {
    const raw = await fs.readFile(cacheFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<GearCacheFile>
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return

    for (const entry of parsed.entries) {
      if (!isGearCacheEntry(entry)) continue
      entries.set(entry.albumId, entry)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error('[gear] failed to load gear-cache.json:', error)
    }
  }
}

export function getGearCacheEntry(albumId: string): GearCacheEntry | undefined {
  return entries.get(albumId)
}

export function setGearCacheEntry(entry: GearCacheEntry): void {
  entries.set(entry.albumId, entry)
  dirty = true
  scheduleWrite()
}

export function removeGearCache(albumId: string): void {
  if (!entries.delete(albumId)) return
  dirty = true
  scheduleWrite()
}

/** 相册库变化后裁掉已经不存在的相册 */
export function pruneGearCache(albumIds: Set<string>): void {
  let changed = false
  for (const albumId of entries.keys()) {
    if (!albumIds.has(albumId)) {
      entries.delete(albumId)
      changed = true
    }
  }
  if (changed) {
    dirty = true
    scheduleWrite()
  }
}

function serialize(): string {
  const snapshot: GearCacheFile = {
    version: CACHE_VERSION,
    entries: Array.from(entries.values())
  }
  return JSON.stringify(snapshot)
}

function tempFileFor(file: string): string {
  writeSequence += 1
  return `${file}.${process.pid}.${writeSequence}.tmp`
}

function scheduleWrite(): void {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    void flushGearCache()
  }, WRITE_DEBOUNCE_MS)
}

export function flushGearCache(): Promise<void> {
  if (!dirty) return writeQueue
  dirty = false
  const serialized = serialize()

  writeQueue = writeQueue
    .then(async () => {
      const file = cacheFile()
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tempFile = tempFileFor(file)
      await fs.writeFile(tempFile, serialized, 'utf8')
      await fs.rename(tempFile, file)
    })
    .catch((error) => {
      console.error('[gear] failed to save gear-cache.json:', error)
    })

  return writeQueue
}

/** 退出时同步落盘，避免最后几个相册的采样结果丢失 */
export function flushGearCacheSync(): void {
  if (!dirty) return
  dirty = false
  try {
    const file = cacheFile()
    fsSync.mkdirSync(path.dirname(file), { recursive: true })
    const tempFile = tempFileFor(file)
    fsSync.writeFileSync(tempFile, serialize(), 'utf8')
    fsSync.renameSync(tempFile, file)
  } catch (error) {
    console.error('[gear] failed to save gear-cache.json on quit:', error)
  }
}

/** 机身名归一化：忽略大小写、全半角与多余空白 */
function gearKey(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
}

async function readGearSample(
  source: AlbumSampleSource,
  index: number
): Promise<GearSample | null> {
  const file = registerAlbumSample(source, index)
  const cached = source.photos[index]
  if (!file || !cached) return null

  let camera: string | null = null
  let lens: string | null = null
  try {
    const info = await readGearExif(file.path)
    camera = info.camera
    lens = info.lens
  } catch (error) {
    console.warn('[gear] 无法读取 EXIF:', file.path, error)
  }

  return {
    index,
    id: photoId(file.path),
    mtimeMs: cached.mtimeMs,
    size: cached.size,
    createdAt: cached.createdAt,
    camera,
    lens
  }
}

/**
 * 相似分析顺带写入相似缓存的镜头信息。
 * 只采纳仍指向当前文件的条目；覆盖范围是用户浏览/分析过的窗口，不是整本相册。
 */
async function readAnalysisLenses(
  albumId: string,
  source: AlbumSampleSource
): Promise<Map<string, string>> {
  const lensById = new Map<string, string>()
  try {
    const entries = await getCachedGearInfo(albumId)
    if (entries.length === 0) return lensById

    const current = new Map<string, { mtimeMs: number; size: number }>()
    for (const photo of source.photos) {
      current.set(photoId(path.join(source.dir, photo.name)), {
        mtimeMs: photo.mtimeMs,
        size: photo.size
      })
    }

    for (const entry of entries) {
      if (!entry.lens) continue
      const photo = current.get(entry.id)
      if (!photo || photo.mtimeMs !== entry.mtimeMs || photo.size !== entry.size) continue
      lensById.set(entry.id, entry.lens)
    }
  } catch (error) {
    console.warn('[gear] failed to read analysis lens info:', albumId, error)
  }
  return lensById
}

function cameraKeysOf(samples: GearSample[]): Set<string> {
  const keys = new Set<string>()
  for (const sample of samples) {
    if (sample.camera) keys.add(gearKey(sample.camera))
  }
  return keys
}

/** 参考样本不足以下结论时扩展到相册后段 */
function needsVerification(samples: GearSample[]): boolean {
  const withCamera = samples.filter((sample) => sample.camera).length
  return withCamera < 2 || cameraKeysOf(samples).size > 1
}

function initialIndexes(count: number): number[] {
  return Array.from({ length: Math.min(INITIAL_SAMPLE, count) }, (_, index) => index)
}

/** 25% / 50% / 75% / 100% 位置，避免只看开头集中的几张 */
function spreadIndexes(count: number): number[] {
  const indexes = new Set<number>()
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    indexes.add(Math.round((count - 1) * fraction))
  }
  return Array.from(indexes)
}

async function sampleAlbum(source: AlbumSampleSource): Promise<GearSample[]> {
  const count = source.photos.length
  if (count === 0) return []

  const initial = initialIndexes(count)
  const samples = (
    await mapLimit(initial, SAMPLE_CONCURRENCY, (index) => readGearSample(source, index))
  ).filter((sample): sample is GearSample => sample !== null)

  if (!needsVerification(samples) || samples.length >= MAX_SAMPLE) {
    return samples
  }

  const seen = new Set(samples.map((sample) => sample.index))
  const extra = spreadIndexes(count)
    .filter((index) => !seen.has(index))
    .slice(0, MAX_SAMPLE - samples.length)
  if (extra.length === 0) return samples

  const more = (
    await mapLimit(extra, SAMPLE_CONCURRENCY, (index) => readGearSample(source, index))
  ).filter((sample): sample is GearSample => sample !== null)

  return [...samples, ...more].sort((a, b) => a.index - b.index)
}

/** 样本中的相机/镜头分布；机身展示名取出现次数最多的写法 */
function summarizeAlbum(
  albumId: string,
  photoCount: number,
  samples: GearSample[],
  analysisLenses: Map<string, string> | null = null
): AlbumSummary {
  const cameraCounts = new Map<string, number>()
  const cameraLatest = new Map<string, number>()
  const cameraNames = new Map<string, Map<string, number>>()
  const lensById = new Map<string, string>()
  let sampleWithCamera = 0
  let latestSampleAt: number | null = null

  for (const sample of samples) {
    if (latestSampleAt === null || sample.createdAt > latestSampleAt) {
      latestSampleAt = sample.createdAt
    }

    if (sample.camera) {
      sampleWithCamera += 1
      const key = gearKey(sample.camera)
      cameraCounts.set(key, (cameraCounts.get(key) ?? 0) + 1)
      const latest = cameraLatest.get(key)
      if (latest === undefined || sample.createdAt > latest) {
        cameraLatest.set(key, sample.createdAt)
      }

      const names = cameraNames.get(key) ?? new Map<string, number>()
      names.set(sample.camera, (names.get(sample.camera) ?? 0) + 1)
      cameraNames.set(key, names)
    }

    if (sample.lens) lensById.set(sample.id, sample.lens)
  }

  // 相似分析读过镜头的照片补进分布；按照片 id 合并，避免和参考样本重复计数
  if (analysisLenses) {
    for (const [id, lens] of analysisLenses) lensById.set(id, lens)
  }

  const lensCounts = new Map<string, number>()
  for (const lens of lensById.values()) {
    lensCounts.set(lens, (lensCounts.get(lens) ?? 0) + 1)
  }

  // 多数票决定主机身；票数相同时取样本中更新的一张
  let primaryKey: string | null = null
  for (const [key, count] of cameraCounts) {
    if (primaryKey === null) {
      primaryKey = key
      continue
    }
    const best = cameraCounts.get(primaryKey) ?? 0
    if (count > best) {
      primaryKey = key
    } else if (count === best) {
      const latest = cameraLatest.get(key) ?? 0
      const bestLatest = cameraLatest.get(primaryKey) ?? 0
      if (latest > bestLatest) primaryKey = key
    }
  }

  const cameras: StatsBucket[] = Array.from(cameraCounts.entries())
    .map(([key, count]) => {
      const names = cameraNames.get(key)
      let label = key
      let best = 0
      if (names) {
        for (const [name, nameCount] of names) {
          if (nameCount > best) {
            best = nameCount
            label = name
          }
        }
      }
      return { label, count }
    })
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  const primaryName = primaryKey
    ? (Array.from(cameraNames.get(primaryKey)?.entries() ?? []).sort(
        (a, b) => b[1] - a[1]
      )[0]?.[0] ?? null)
    : null

  let referenceLens: string | null = null
  let bestLens = 0
  for (const [lens, count] of lensCounts) {
    if (count > bestLens) {
      bestLens = count
      referenceLens = lens
    }
  }

  return {
    info: {
      albumId,
      photoCount,
      cameraKey: primaryKey,
      cameraName: primaryName,
      cameras,
      mixed: cameraCounts.size > 1,
      sampleCount: samples.length,
      sampleWithCamera,
      referenceLens,
      lensPhotoCount: lensById.size,
      latestSampleAt
    },
    lensCounts
  }
}

function matchesSource(entry: GearCacheEntry, source: AlbumSampleSource): boolean {
  if (entry.sampleVersion !== SAMPLE_VERSION) return false
  if (normalizePath(entry.path) !== normalizePath(source.dir)) return false
  if (entry.photoCount !== source.photoCount) return false
  if (source.photoCount > 0 && entry.sample.length === 0) return false

  for (const sample of entry.sample) {
    const cached = source.photos[sample.index]
    if (!cached) return false
    if (cached.mtimeMs !== sample.mtimeMs || cached.size !== sample.size) return false
    if (photoId(path.join(source.dir, cached.name)) !== sample.id) return false
  }
  return true
}

function topBuckets(counts: Map<string, number>, limit: number): StatsBucket[] {
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit)
}

interface DeviceAccumulator {
  key: string
  nameCounts: Map<string, number>
  nameLatest: Map<string, number>
  albumIds: string[]
  photoCount: number
  coverAlbumId: string | null
  coverAt: number
  lenses: Map<string, number>
  lensPhotoCount: number
  sampleCount: number
  sampleWithCamera: number
  mixedAlbumCount: number
}

function buildDevices(
  albums: GearAlbumInfo[],
  summaries: Map<string, AlbumSummary>
): GearDevice[] {
  const devices = new Map<string, DeviceAccumulator>()

  for (const album of albums) {
    const key = album.cameraKey
    if (!key) continue

    let device = devices.get(key)
    if (!device) {
      device = {
        key,
        nameCounts: new Map(),
        nameLatest: new Map(),
        albumIds: [],
        photoCount: 0,
        coverAlbumId: null,
        coverAt: -Infinity,
        lenses: new Map(),
        lensPhotoCount: 0,
        sampleCount: 0,
        sampleWithCamera: 0,
        mixedAlbumCount: 0
      }
      devices.set(key, device)
    }

    device.albumIds.push(album.albumId)
    device.photoCount += album.photoCount
    device.lensPhotoCount += album.lensPhotoCount
    device.sampleCount += album.sampleCount
    device.sampleWithCamera += album.sampleWithCamera
    if (album.mixed) device.mixedAlbumCount += 1

    if (album.cameraName) {
      const weight = Math.max(1, album.sampleWithCamera)
      device.nameCounts.set(
        album.cameraName,
        (device.nameCounts.get(album.cameraName) ?? 0) + weight
      )
      const latest = album.latestSampleAt ?? 0
      const previous = device.nameLatest.get(album.cameraName)
      if (previous === undefined || latest > previous) {
        device.nameLatest.set(album.cameraName, latest)
      }
    }

    const summary = summaries.get(album.albumId)
    if (summary) {
      for (const [lens, count] of summary.lensCounts) {
        device.lenses.set(lens, (device.lenses.get(lens) ?? 0) + count)
      }
    }

    const albumAt = album.latestSampleAt ?? -Infinity
    if (device.coverAlbumId === null || albumAt > device.coverAt) {
      device.coverAt = albumAt
      device.coverAlbumId = album.albumId
    }
  }

  return Array.from(devices.values())
    .map((device) => {
      let name = device.key
      let best = 0
      let bestLatest = -Infinity
      for (const [candidate, count] of device.nameCounts) {
        const latest = device.nameLatest.get(candidate) ?? -Infinity
        if (count > best || (count === best && latest > bestLatest)) {
          best = count
          bestLatest = latest
          name = candidate
        }
      }
      return {
        key: device.key,
        name,
        albumIds: device.albumIds,
        albumCount: device.albumIds.length,
        photoCount: device.photoCount,
        coverAlbumId: device.coverAlbumId,
        referenceLenses: topBuckets(device.lenses, DEVICE_LENS_LIMIT),
        lensPhotoCount: device.lensPhotoCount,
        sampleCount: device.sampleCount,
        sampleWithCamera: device.sampleWithCamera,
        mixedAlbumCount: device.mixedAlbumCount
      }
    })
    .sort(
      (a, b) =>
        b.albumCount - a.albumCount ||
        b.photoCount - a.photoCount ||
        a.name.localeCompare(b.name)
    )
}

/**
 * 一次设备库扫描：先校验缓存并立即推送，再按顺序补齐待读相册。
 * 每读完一个相册就写入缓存；pause 会在当前相册结束后停下。
 */
export class GearScanJob {
  private readonly records: GearAlbumRecord[]
  private listener: GearSnapshotListener
  private readonly refresh: boolean
  private readonly summaries = new Map<string, AlbumSummary>()
  private readonly unknown = new Set<string>()
  private readonly missing = new Set<string>()
  private checked = 0
  private total: number
  private paused = false
  private finished = false
  private error: string | null = null
  private running: Promise<void> | null = null
  private latest: GearSnapshot | null = null
  private lastEmit = 0
  private emitTimer: ReturnType<typeof setTimeout> | null = null

  constructor(records: GearAlbumRecord[], listener: GearSnapshotListener, refresh = false) {
    this.records = records
    this.listener = listener
    this.refresh = refresh
    this.total = records.length
  }

  addListener(listener: GearSnapshotListener): void {
    this.listener = listener
    if (this.latest) listener(this.latest)
  }

  start(): Promise<void> {
    if (this.running) return this.running
    this.running = this.run()
    return this.running
  }

  async pause(): Promise<void> {
    this.paused = true
    this.clearEmitTimer()
    if (this.running) await this.running
    this.emit(true)
  }

  private async run(): Promise<void> {
    try {
      const pending = await this.validateCached()
      if (!this.paused) {
        for (const record of pending) {
          if (this.paused) break
          await this.checkAlbum(record)
          this.emit()
        }
      }
    } catch (error) {
      console.error('[gear] scan failed:', error)
      this.error = '设备库扫描失败，请稍后重试'
    } finally {
      this.finished = true
      this.emit(true)
    }
  }

  /**
   * 校验缓存：目录签名未变时直接采用已有样本并立即形成快照；
   * 无效或缺失的相册留给后续逐本读取。返回值不保留照片列表，避免大库常驻内存。
   */
  private async validateCached(): Promise<GearAlbumRecord[]> {
    const pending: GearAlbumRecord[] = []

    await mapLimit(this.records, VALIDATE_CONCURRENCY, async (record) => {
      try {
        const source = await getAlbumSampleSource(record.path, this.refresh)

        if (source.missing) {
          this.missing.add(record.id)
          this.checked += 1
          this.emit()
          return
        }

        if (source.photoCount === 0) {
          this.unknown.add(record.id)
          this.checked += 1
          this.emit()
          return
        }

        const entry = this.refresh ? undefined : getGearCacheEntry(record.id)
        if (entry && matchesSource(entry, source)) {
          const analysisLenses = await readAnalysisLenses(record.id, source)
          this.applySummary(
            record.id,
            summarizeAlbum(record.id, source.photoCount, entry.sample, analysisLenses)
          )
          this.checked += 1
          this.emit()
          return
        }

        pending.push(record)
      } catch (error) {
        console.warn('[gear] failed to inspect album:', record.path, error)
        this.unknown.add(record.id)
        this.checked += 1
        this.emit()
      }
    })

    // mapLimit 保证返回顺序，但 pending 是并发 push 的；按相册库顺序重新排列
    const order = new Map(this.records.map((record, index) => [record.id, index]))
    pending.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    this.emit(true)
    return pending
  }

  private async checkAlbum(record: GearAlbumRecord): Promise<void> {
    try {
      const source = await getAlbumSampleSource(record.path)
      if (source.missing) {
        this.missing.add(record.id)
        this.unknown.delete(record.id)
        this.summaries.delete(record.id)
      } else {
        this.missing.delete(record.id)
        if (source.photoCount === 0) {
          this.unknown.add(record.id)
          this.summaries.delete(record.id)
        } else {
          const samples = await sampleAlbum(source)
          const analysisLenses = await readAnalysisLenses(record.id, source)
          this.applySummary(
            record.id,
            summarizeAlbum(record.id, source.photoCount, samples, analysisLenses)
          )
          setGearCacheEntry({
            albumId: record.id,
            path: source.dir,
            photoCount: source.photoCount,
            sampleVersion: SAMPLE_VERSION,
            checkedAt: Date.now(),
            sample: samples
          })
        }
      }
    } catch (error) {
      console.warn('[gear] failed to sample album:', record.path, error)
      this.unknown.add(record.id)
      this.summaries.delete(record.id)
    } finally {
      this.checked += 1
    }
  }

  private applySummary(albumId: string, summary: AlbumSummary): void {
    this.missing.delete(albumId)
    if (summary.info.cameraKey) {
      this.unknown.delete(albumId)
      this.summaries.set(albumId, summary)
    } else {
      this.unknown.add(albumId)
      this.summaries.delete(albumId)
    }
  }

  private buildSnapshot(): GearSnapshot {
    const albums: GearAlbumInfo[] = []
    const unknownAlbumIds: string[] = []
    const missingAlbumIds: string[] = []

    for (const record of this.records) {
      if (this.missing.has(record.id)) {
        missingAlbumIds.push(record.id)
        continue
      }
      const summary = this.summaries.get(record.id)
      if (summary) {
        albums.push(summary.info)
      } else if (this.unknown.has(record.id)) {
        unknownAlbumIds.push(record.id)
      }
    }

    return {
      albums,
      cameras: buildDevices(albums, this.summaries),
      unknownAlbumIds,
      missingAlbumIds,
      checkedAlbums: this.checked,
      totalAlbums: this.total,
      scanning: !this.finished && !this.paused,
      error: this.error
    }
  }

  private clearEmitTimer(): void {
    if (!this.emitTimer) return
    clearTimeout(this.emitTimer)
    this.emitTimer = null
  }

  private emit(immediate = false): void {
    if (this.paused && !immediate) return
    const now = Date.now()
    const elapsed = now - this.lastEmit
    if (immediate || elapsed >= SNAPSHOT_INTERVAL_MS) {
      this.clearEmitTimer()
      this.lastEmit = now
      this.push()
      return
    }
    if (this.emitTimer) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      if (this.paused) return
      this.lastEmit = Date.now()
      this.push()
    }, SNAPSHOT_INTERVAL_MS - elapsed)
    this.emitTimer.unref?.()
  }

  private push(): void {
    const snapshot = this.buildSnapshot()
    this.latest = snapshot
    this.listener(snapshot)
  }
}
