import { app } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import type { SimilarSnapshot } from '../shared/types'
import { computePHash, IncrementalSimilarCluster } from './imageHash'
import { photoId, type PhotoFile } from './photos'
import { loadImageInput } from './thumbnails'
import { mapLimit } from './util'

const CACHE_VERSION = 1
/** 解码图片比读 EXIF 更吃 CPU/磁盘，控制并发避免明显拖慢当前浏览 */
const READ_CONCURRENCY = 4
/** 每批重新读取一次视口位置，屏幕移动后下一批立刻换到新区域 */
const BATCH_SIZE = 8
/** 分组快照包含完整组列表，降低推送频率，避免大相册反复传输 */
const SNAPSHOT_INTERVAL_MS = 1000
/** 定期落盘，取消或异常退出时最多丢几秒的指纹 */
const CHECKPOINT_INTERVAL_MS = 5000

interface CachedHashEntry {
  /** 与原文件对比，文件变化后自动失效 */
  mtimeMs: number
  size: number
  /** null 表示之前尝试过但无法解码；文件变化后会重试 */
  hash: string | null
}

interface CacheFile {
  version: number
  entries: Record<string, CachedHashEntry>
}

interface AlbumCache {
  entries: Map<string, CachedHashEntry>
  dirty: boolean
}

export type SimilarSnapshotListener = (snapshot: SimilarSnapshot) => void

/** 按相册分文件缓存，避免启动时加载整个库的指纹 */
const caches = new Map<string, AlbumCache>()
let writeSequence = 0

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'similar-cache')
}

function cacheFile(albumId: string): string {
  return path.join(cacheDir(), `${albumId}.json`)
}

function isHash(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[0-9a-f]{16}$/.test(value))
}

function isCachedEntry(value: unknown): value is CachedHashEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.mtimeMs === 'number' &&
    Number.isFinite(entry.mtimeMs) &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size) &&
    isHash(entry.hash)
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
      console.warn('[similar] failed to load cache:', albumId, error)
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
  const entries: Record<string, CachedHashEntry> = {}
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
    console.warn('[similar] failed to save cache:', albumId, error)
  }
}

/** 退出时同步落盘，保留已经计算出的指纹 */
export function flushSimilarCacheSync(): void {
  for (const [albumId, cache] of caches) {
    if (!cache.dirty) continue
    cache.dirty = false

    try {
      const entries: Record<string, CachedHashEntry> = {}
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
      console.warn('[similar] failed to save cache on quit:', albumId, error)
    }
  }
}

/** 从相册库移除时清掉对应的指纹缓存 */
export function removeAlbumSimilarCache(albumId: string): void {
  caches.delete(albumId)
  void fs.rm(cacheFile(albumId), { force: true }).catch(() => undefined)
}

async function readPhotoHash(file: PhotoFile): Promise<string | null> {
  try {
    return await computePHash(await loadImageInput(file.path))
  } catch {
    // 单张损坏/不支持不阻塞整本相册；null 也会写入缓存，文件变化后重试
    return null
  }
}

/**
 * 一次相册相似分析。照片按视口优先顺序读取指纹，但分组使用增量聚类：
 * 已经出现在界面上的组只会增长，不会因为后续照片被拆开。
 */
export class SimilarAnalysisJob {
  private readonly albumId: string
  private readonly photos: PhotoFile[]
  private readonly ids: string[]
  private readonly orderById = new Map<string, number>()
  private readonly cluster = new IncrementalSimilarCluster()
  private readonly listeners = new Set<SimilarSnapshotListener>()

  private cache: AlbumCache | null = null
  private pending: number[] = []
  private processed = 0
  private viewportStart = 0
  private viewportEnd = 31
  private stopped = false
  private completed = false
  private error: string | null = null

  private latest: SimilarSnapshot | null = null
  private lastSnapshotAt = 0
  private lastCheckpointAt = 0
  private running: Promise<void> | null = null

  constructor(albumId: string, photos: PhotoFile[]) {
    this.albumId = albumId
    this.photos = photos
    this.ids = photos.map((photo) => photoId(photo.path))
    for (let index = 0; index < this.ids.length; index += 1) {
      this.orderById.set(this.ids[index], index)
    }
  }

  addListener(listener: SimilarSnapshotListener): void {
    this.listeners.add(listener)
    if (this.latest) listener(this.latest)
  }

  /** 渲染进程上报当前可见照片的下标范围，下一批优先处理附近未读照片 */
  setViewport(start: number, end: number): void {
    if (this.photos.length === 0) return
    const lower = Math.max(0, Math.min(start, end))
    const upper = Math.min(this.photos.length - 1, Math.max(start, end))
    this.viewportStart = lower
    this.viewportEnd = Math.max(lower, upper)
  }

  start(): Promise<void> {
    if (!this.running) this.running = this.run()
    return this.running
  }

  /** 离开相册或关闭开关时调用；等在途批次结束后保存已有指纹 */
  async pause(): Promise<void> {
    this.stopped = true
    try {
      await this.running
    } catch {
      // run 内部已记录错误
    }
    this.listeners.clear()
    if (this.cache) await saveCache(this.albumId, new Set(this.ids))
  }

  private async run(): Promise<void> {
    try {
      const cache = await loadCache(this.albumId)
      if (this.stopped) return
      this.cache = cache
      this.lastCheckpointAt = Date.now()

      // 先按相册顺序吸收缓存：缓存完整时无需读图，直接得到最终分组
      for (let index = 0; index < this.photos.length; index += 1) {
        const photo = this.photos[index]
        const id = this.ids[index]
        const cached = cache.entries.get(id)
        if (cached && cached.mtimeMs === photo.mtimeMs && cached.size === photo.size) {
          this.processed += 1
          if (cached.hash) this.cluster.add(id, cached.hash)
        } else {
          this.pending.push(index)
        }
      }

      this.completed = this.pending.length === 0
      this.emit(true)
      if (this.completed) {
        await saveCache(this.albumId, new Set(this.ids))
        return
      }

      while (!this.stopped && this.pending.length > 0) {
        const batch = this.takeBatch()
        const hashes = await mapLimit(batch, READ_CONCURRENCY, async (index) => {
          const photo = this.photos[index]
          const id = this.ids[index]
          const hash = await readPhotoHash(photo)
          cache.entries.set(id, { mtimeMs: photo.mtimeMs, size: photo.size, hash })
          cache.dirty = true
          return hash
        })

        // 同一批按相册顺序加入聚类，减少视口跳转带来的组顺序抖动
        for (let offset = 0; offset < batch.length; offset += 1) {
          const hash = hashes[offset]
          if (hash) this.cluster.add(this.ids[batch[offset]], hash)
          this.processed += 1
        }

        await this.maybeCheckpoint()
        if (!this.stopped) this.emit(false)
      }

      if (!this.stopped) {
        this.completed = true
        this.emit(true)
      }
      await saveCache(this.albumId, new Set(this.ids))
    } catch (error) {
      console.error('[similar] analysis failed:', this.albumId, error)
      this.error = '相似照片分析失败'
      this.completed = true
      this.emit(true)
      // 出错前算出的指纹仍然有效，落盘后下次可以继续
      try {
        await saveCache(this.albumId, new Set(this.ids))
      } catch {
        // saveCache 内部已经记录错误
      }
    }
  }

  /** 选出离当前视口最近的一批未读照片，批内再按相册顺序处理 */
  private takeBatch(): number[] {
    const start = this.viewportStart
    const end = this.viewportEnd
    const score = (index: number): number => {
      if (index < start) return start - index
      if (index > end) return index - end
      return 0
    }

    this.pending.sort((a, b) => score(a) - score(b) || a - b)
    const batch = this.pending.splice(0, Math.min(BATCH_SIZE, this.pending.length))
    batch.sort((a, b) => a - b)
    return batch
  }

  private async maybeCheckpoint(): Promise<void> {
    const now = Date.now()
    if (now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return
    this.lastCheckpointAt = now
    await saveCache(this.albumId, new Set(this.ids))
  }

  private emit(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return
    this.lastSnapshotAt = now

    const groups = this.cluster.getGroups().map((group) => ({
      // 组内按相册默认顺序排列，扑克牌封面与观赏窗口顺序保持稳定
      photoIds: [...group.photoIds].sort(
        (a, b) => (this.orderById.get(a) ?? 0) - (this.orderById.get(b) ?? 0)
      )
    }))
    groups.sort(
      (a, b) =>
        (this.orderById.get(a.photoIds[0]) ?? 0) - (this.orderById.get(b.photoIds[0]) ?? 0)
    )

    const snapshot: SimilarSnapshot = {
      albumId: this.albumId,
      groups,
      processed: this.processed,
      total: this.photos.length,
      complete: this.completed || (this.pending.length === 0 && !this.stopped),
      error: this.error
    }
    this.latest = snapshot

    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.warn('[similar] snapshot listener failed:', error)
      }
    }
  }
}
