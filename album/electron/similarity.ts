import { app } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import type { SimilarGroup, SimilarSnapshot } from '../shared/types'
import {
  computeSignature,
  IncrementalSimilarCluster,
  mergeSimilarGroups,
  type PhotoSignature
} from './imageHash'
import { photoId, type PhotoFile } from './photos'
import { getAnalysisThumbnail, isThumbnailDropped } from './thumbnails'

/** v3 改为复用 320px 网格缩略图计算指纹；旧版本缓存按原图算，整本重算一次 */
const CACHE_VERSION = 3
/** 解码图片比读 EXIF 更吃 CPU/磁盘，控制并发避免明显拖慢当前浏览 */
const READ_CONCURRENCY = 4
/** 每批重新读取一次视口位置，屏幕移动后下一批立刻换到新区域 */
const BATCH_SIZE = 8
/**
 * 窗口在可视范围上下各扩展少量照片。缩略图本来就要为显示生成，
 * 分析可直接复用，因此不再需要预读一整屏来抵消滚动延迟。
 */
const WINDOW_MARGIN_RATIO = 0.3
const WINDOW_MARGIN_MIN = 12
const WINDOW_MARGIN_MAX = 32
/** 滚动期间先让缩略图读盘，滚动停下后再分析；避免磁盘/CPU 争抢 */
const VIEWPORT_SETTLE_MS = 250
/** 分组快照包含完整组列表，降低推送频率，避免大相册反复传输 */
const SNAPSHOT_INTERVAL_MS = 1000
/** 定期落盘，取消或异常退出时最多丢几秒的指纹 */
const CHECKPOINT_INTERVAL_MS = 5000

interface CachedSignatureEntry {
  /** 与原文件对比，文件变化后自动失效 */
  mtimeMs: number
  size: number
  /** null 表示之前尝试过但无法解码；文件变化后会重试 */
  hash: string | null
  /** 48 个 0–255 的 RGB 均值；hash 为 null 时它也必须是 null */
  color: number[] | null
}

interface CacheFile {
  version: number
  entries: Record<string, CachedSignatureEntry>
}

interface AlbumCache {
  entries: Map<string, CachedSignatureEntry>
  dirty: boolean
}

export type SimilarSnapshotListener = (snapshot: SimilarSnapshot) => void

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

function isColor(value: unknown): value is number[] | null {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length === 48 &&
      value.every(
        (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255
      ))
  )
}

function isCachedEntry(value: unknown): value is CachedSignatureEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.mtimeMs === 'number' &&
    Number.isFinite(entry.mtimeMs) &&
    typeof entry.size === 'number' &&
    Number.isFinite(entry.size) &&
    isHash(entry.hash) &&
    isColor(entry.color) &&
    (entry.hash === null) === (entry.color === null)
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
  const entries: Record<string, CachedSignatureEntry> = {}
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
      const entries: Record<string, CachedSignatureEntry> = {}
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

async function readPhotoSignature(file: PhotoFile): Promise<PhotoSignature | null> {
  try {
    // 复用网格缩略图：不再解码原图，哈希只看一张约 20KB 的 320px WebP。
    // 缩略图任务与显示请求去重，并且按 analysis 优先级排队，不会抢屏幕内的图。
    return await computeSignature(await getAnalysisThumbnail(file))
  } catch (error) {
    // 切换视图导致的取消不是坏图，交给调用方处理，不能写入 null 缓存
    if (isThumbnailDropped(error)) throw error
    // 单张损坏/不支持不阻塞整本相册；null 也会写入缓存，文件变化后重试
    return null
  }
}

/**
 * 一次相册相似分析。只处理当前视口窗口：窗口内做完就等待，
 * 用户滚动后再跟随新窗口，不强制把整本相册读完。
 * 整本相册恰好全部有指纹时做一次组级合并（通常来自完整缓存）。
 *
 * 已经分析过的照片（含缓存）始终参与增量聚类，所以滚回去或重新进入时组保持稳定。
 */
export class SimilarAnalysisJob {
  private readonly albumId: string
  private readonly photos: PhotoFile[]
  private readonly ids: string[]
  private readonly orderById = new Map<string, number>()
  private readonly signatures = new Map<string, PhotoSignature>()
  private readonly timeById = new Map<string, number>()
  private readonly cluster = new IncrementalSimilarCluster()
  private readonly listeners = new Set<SimilarSnapshotListener>()

  private cache: AlbumCache | null = null
  /** 整本相册中还没有指纹的索引；只在当前窗口内选取 */
  private readonly pending = new Set<number>()
  private processed = 0
  private viewportStart = 0
  private viewportEnd = 31
  /** 最近一次视口变化时间；滚动期间让分析等待，先满足缩略图读盘 */
  private lastViewportSignalAt = 0
  private foreground = false
  private stopped = false
  private albumComplete = false
  /** 缓存吸收完成前不推送快照，避免 pending 尚未建立时误报“已完成” */
  private initialized = false
  /** 窗口空闲时只强制推送一次快照，避免每次唤醒都重复通知 */
  private idleEmitted = false
  private error: string | null = null
  /** 整本相册全部有指纹后的最终分组；未完成时为 null，直接使用增量聚类结果 */
  private finalGroups: SimilarGroup[] | null = null

  private latest: SimilarSnapshot | null = null
  private lastSnapshotAt = 0
  private lastCheckpointAt = 0
  private running: Promise<void> | null = null
  private wake: (() => void) | null = null

  constructor(albumId: string, photos: PhotoFile[]) {
    this.albumId = albumId
    this.photos = photos
    this.ids = photos.map((photo) => photoId(photo.path))
    for (let index = 0; index < this.ids.length; index += 1) {
      this.orderById.set(this.ids[index], index)
      // 合并护栏使用 mtime：该相册的 birthtime 是复制时间，不等于拍摄时间
      this.timeById.set(this.ids[index], photos[index].mtimeMs)
    }
  }

  addListener(listener: SimilarSnapshotListener): void {
    this.listeners.add(listener)
    if (this.latest) listener(this.latest)
  }

  /** 渲染进程上报当前可见照片的下标范围；据此重新划定分析窗口 */
  setViewport(start: number, end: number): void {
    if (this.photos.length === 0) return
    const lower = Math.max(0, Math.min(start, end, this.photos.length - 1))
    const upper = Math.max(lower, Math.min(this.photos.length - 1, Math.max(start, end)))
    const changed = lower !== this.viewportStart || upper !== this.viewportEnd
    this.viewportStart = lower
    this.viewportEnd = upper
    if (!changed) return
    this.lastViewportSignalAt = Date.now()
    // 新窗口可能已经全部命中缓存，重推一次快照以更新“分析中 x/y”
    this.idleEmitted = false
    this.wakeUp()
  }

  /** 观赏窗口打开时让路，关闭后继续；不改变分析结果 */
  setForeground(foreground: boolean): void {
    if (this.foreground === foreground) return
    this.foreground = foreground
    if (!foreground) this.wakeUp()
  }

  start(): Promise<void> {
    if (!this.running) this.running = this.run()
    return this.running
  }

  /** 离开相册或关闭开关时调用；等在途批次结束后保存已有指纹 */
  async pause(): Promise<void> {
    this.stopped = true
    this.wakeUp()
    try {
      await this.running
    } catch {
      // run 内部已记录错误
    }
    this.listeners.clear()
    if (this.cache) await saveCache(this.albumId, new Set(this.ids))
  }

  /** 唤醒正在等待窗口/前台状态的 run 循环 */
  private wakeUp(): void {
    const resolve = this.wake
    if (!resolve) return
    this.wake = null
    resolve()
  }

  private waitForWake(): Promise<void> {
    // pause() 可能在批次执行期间发出停止信号；不要丢掉它，否则会永远等下去
    if (this.stopped) return Promise.resolve()
    return new Promise((resolve) => {
      this.wake = resolve
    })
  }

  private async run(): Promise<void> {
    try {
      const cache = await loadCache(this.albumId)
      if (this.stopped) return
      this.cache = cache
      this.lastCheckpointAt = Date.now()

      // 先按相册顺序吸收缓存：命中的照片无需读图，并参与聚类
      for (let index = 0; index < this.photos.length; index += 1) {
        const photo = this.photos[index]
        const id = this.ids[index]
        const cached = cache.entries.get(id)
        if (cached && cached.mtimeMs === photo.mtimeMs && cached.size === photo.size) {
          this.processed += 1
          if (cached.hash && cached.color) {
            const signature: PhotoSignature = { hash: cached.hash, color: cached.color }
            this.signatures.set(id, signature)
            this.cluster.add(id, signature)
          }
        } else {
          this.pending.add(index)
        }
      }

      this.initialized = true
      this.updateCompletion()
      this.emit(true)
      this.idleEmitted = true
      if (this.albumComplete) {
        await saveCache(this.albumId, new Set(this.ids))
      }

      while (!this.stopped) {
        if (this.foreground) {
          await this.waitForWake()
          continue
        }

        // 用户还在滚动时先让缩略图读盘，停稳后再分析当前窗口
        const settle = this.lastViewportSignalAt + VIEWPORT_SETTLE_MS - Date.now()
        if (settle > 0) {
          await sleep(settle)
          continue
        }

        const { results: batch, aborted } = await this.readBatch()
        if (batch.length === 0) {
          // 当前窗口已经处理完：真正停下来，等滚动或恢复再唤醒
          if (!aborted && !this.idleEmitted) {
            this.idleEmitted = true
            this.emit(true)
          }
          await this.waitForWake()
          continue
        }
        this.idleEmitted = false

        // 同一批按相册顺序加入聚类，减少视口跳转带来的组顺序抖动
        batch.sort((a, b) => a.index - b.index)
        for (const { index, signature } of batch) {
          const id = this.ids[index]
          if (signature) {
            this.signatures.set(id, signature)
            this.cluster.add(id, signature)
          }
          this.processed += 1
        }

        const wasComplete = this.albumComplete
        this.updateCompletion()
        await this.maybeCheckpoint()
        if (this.albumComplete && !wasComplete) {
          await saveCache(this.albumId, new Set(this.ids))
        }
        if (!this.stopped) this.emit(false)

        // 缩略图被取消（切换视图）：等下一次视口/前台信号再重试，避免空转
        if (aborted) await this.waitForWake()
      }

      await saveCache(this.albumId, new Set(this.ids))
    } catch (error) {
      console.error('[similar] analysis failed:', this.albumId, error)
      this.error = '相似照片分析失败'
      this.albumComplete = true
      this.initialized = true
      this.idleEmitted = true
      this.emit(true)
      // 出错前算出的指纹仍然有效，落盘后下次可以继续
      try {
        await saveCache(this.albumId, new Set(this.ids))
      } catch {
        // saveCache 内部已经记录错误
      }
    }
  }

  /** 当前分析范围：可视区 ± 半屏 */
  private windowBounds(): { start: number; end: number } {
    if (this.photos.length === 0) return { start: 0, end: -1 }

    const viewportSize = Math.max(1, this.viewportEnd - this.viewportStart + 1)
    const margin = Math.min(
      WINDOW_MARGIN_MAX,
      Math.max(WINDOW_MARGIN_MIN, Math.ceil(viewportSize * WINDOW_MARGIN_RATIO))
    )
    return {
      start: Math.max(0, this.viewportStart - margin),
      end: Math.min(this.photos.length - 1, this.viewportEnd + margin)
    }
  }

  /** 整本照片都有指纹后，计算一次最终分组 */
  private updateCompletion(): void {
    if (this.albumComplete || this.pending.size > 0) return
    this.albumComplete = true
    this.finalGroups = this.buildFinalGroups()
  }

  /** 当前窗口内离可视区最近的一张待读照片；每读一张都重新判断，滚动后可立刻转向 */
  private takeNext(): number | undefined {
    if (this.pending.size === 0) return undefined

    const { start, end } = this.windowBounds()
    const viewStart = this.viewportStart
    const viewEnd = this.viewportEnd
    let best: number | undefined
    let bestScore = Number.POSITIVE_INFINITY

    for (const index of this.pending) {
      if (index < start || index > end) continue
      const score =
        index < viewStart ? viewStart - index : index > viewEnd ? index - viewEnd : 0
      if (score < bestScore || (score === bestScore && best !== undefined && index < best)) {
        best = index
        bestScore = score
      }
    }

    if (best !== undefined) this.pending.delete(best)
    return best
  }

  /**
   * 读取一批照片的指纹。每个并发 worker 完成一张后才取下一张，
   * 取的时候重新按当前窗口挑选，因此拖动滚动条后旧窗口最多只剩几张在读。
   */
  private async readBatch(): Promise<{
    results: { index: number; signature: PhotoSignature | null }[]
    aborted: boolean
  }> {
    const results: { index: number; signature: PhotoSignature | null }[] = []
    let budget = BATCH_SIZE
    let aborted = false

    const worker = async (): Promise<void> => {
      while (!this.stopped && budget > 0) {
        const index = this.takeNext()
        if (index === undefined) return
        budget -= 1

        const photo = this.photos[index]
        const id = this.ids[index]
        let signature: PhotoSignature | null
        try {
          signature = await readPhotoSignature(photo)
        } catch {
          // 离开相册/切换视图时缩略图任务被取消：放回待读集合，下次进入重试
          this.pending.add(index)
          aborted = true
          return
        }
        if (this.cache) {
          this.cache.entries.set(id, {
            mtimeMs: photo.mtimeMs,
            size: photo.size,
            hash: signature?.hash ?? null,
            color: signature?.color ?? null
          })
          this.cache.dirty = true
        }
        results.push({ index, signature })
      }
    }

    await Promise.all(Array.from({ length: READ_CONCURRENCY }, () => worker()))
    return { results, aborted }
  }

  /** 当前分析范围内待分析与总张数，用于进度展示 */
  private windowCounts(): { pending: number; total: number } {
    if (this.photos.length === 0) return { pending: 0, total: 0 }
    const { start, end } = this.windowBounds()
    let pending = 0
    for (const index of this.pending) {
      if (index >= start && index <= end) pending += 1
    }
    return { pending, total: Math.max(0, end - start + 1) }
  }

  private async maybeCheckpoint(): Promise<void> {
    const now = Date.now()
    if (now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return
    this.lastCheckpointAt = now
    await saveCache(this.albumId, new Set(this.ids))
  }

  /** 整本相册完成后做一次组级合并；失败时退回增量聚类结果 */
  private buildFinalGroups(): SimilarGroup[] {
    try {
      const merged = mergeSimilarGroups(
        this.cluster.getGroups(true),
        this.signatures,
        this.timeById
      )
      return this.normalizeGroups(
        merged.filter((group) => group.photoIds.length >= 2)
      )
    } catch (error) {
      console.warn('[similar] group merge failed:', this.albumId, error)
      return this.normalizeGroups(this.cluster.getGroups())
    }
  }

  /** 组内、组间都按相册默认顺序排列，保证封面与观赏窗口顺序稳定 */
  private normalizeGroups(groups: SimilarGroup[]): SimilarGroup[] {
    const sorted = groups.map((group) => ({
      photoIds: [...group.photoIds].sort(
        (a, b) => (this.orderById.get(a) ?? 0) - (this.orderById.get(b) ?? 0)
      )
    }))
    sorted.sort(
      (a, b) =>
        (this.orderById.get(a.photoIds[0]) ?? 0) - (this.orderById.get(b.photoIds[0]) ?? 0)
    )
    return sorted
  }

  private emit(force: boolean): void {
    if (!this.initialized) return
    const now = Date.now()
    if (!force && now - this.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return
    this.lastSnapshotAt = now

    const groups: SimilarGroup[] =
      this.finalGroups ?? this.normalizeGroups(this.cluster.getGroups())
    const window = this.windowCounts()

    const snapshot: SimilarSnapshot = {
      albumId: this.albumId,
      groups,
      processed: this.processed,
      total: this.photos.length,
      complete: window.pending === 0,
      albumComplete: this.albumComplete,
      windowPending: window.pending,
      windowTotal: window.total,
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
