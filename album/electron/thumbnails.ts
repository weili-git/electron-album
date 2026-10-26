import { app, protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import sharp from 'sharp'
import { extractThumbnail } from 'extract-raw-preview'
import { getPhotoFile, type PhotoFile } from './photos'
import { normalizePath } from './util'

const SCHEME = 'thumb'
const THUMB_HOST = 'photo'
const CACHE_VERSION = 'v1'
/** 缩略图宽度档位，避免任意宽度导致缓存膨胀 */
const WIDTH_BUCKETS = [160, 320, 480, 640, 960, 1280, 1920]
const DEFAULT_WIDTH = 320
/** 兼顾吞吐与风扇/磁盘压力，最多 8 个并发生成 */
const MAX_CONCURRENCY = Math.max(4, Math.min(8, os.availableParallelism()))
/** 每个 sharp 任务内部单线程，避免与外部并发叠加造成 CPU 超订 */
sharp.concurrency(1)

/**
 * 缩略图用途：观赏窗口 > 网格 > 相册封面。
 * 队列按该顺序取任务，避免封面生成阻塞用户刚打开的照片。
 */
type ThumbPriority = 'view' | 'grid' | 'cover'
const PRIORITY_ORDER: ThumbPriority[] = ['view', 'grid', 'cover']

class ThumbnailDroppedError extends Error {
  constructor() {
    super('thumbnail request no longer visible')
    this.name = 'ThumbnailDroppedError'
  }
}

interface QueueEntry {
  /** 照片所属相册目录，用于切换视图时丢弃旧任务 */
  scope: string
  start: () => void
  reject: (error: unknown) => void
}

class ThumbnailQueue {
  private active = 0
  private readonly queues: Record<ThumbPriority, QueueEntry[]> = {
    view: [],
    grid: [],
    cover: []
  }

  constructor(private readonly max: number) {}

  run<T>(priority: ThumbPriority, scope: string, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        scope,
        reject,
        start: () => {
          this.active += 1
          task()
            .then(resolve, reject)
            .finally(() => {
              this.active -= 1
              this.startNext()
            })
        }
      }

      if (this.active < this.max) {
        entry.start()
      } else {
        this.queues[priority].push(entry)
      }
    })
  }

  /** 视图切换后，排队中的旧请求已不可见，直接取消，避免继续占用 CPU/磁盘 */
  dropInactive(isActive: (scope: string, priority: ThumbPriority) => boolean): void {
    for (const priority of PRIORITY_ORDER) {
      const queue = this.queues[priority]
      if (queue.length === 0) continue

      let write = 0
      for (let read = 0; read < queue.length; read += 1) {
        const entry = queue[read]
        if (isActive(entry.scope, priority)) {
          queue[write] = entry
          write += 1
        } else {
          entry.reject(new ThumbnailDroppedError())
        }
      }
      queue.length = write
    }
  }

  private startNext(): void {
    for (const priority of PRIORITY_ORDER) {
      const entry = this.queues[priority].shift()
      if (entry) {
        entry.start()
        return
      }
    }
  }
}

const limiter = new ThumbnailQueue(MAX_CONCURRENCY)
const inFlight = new Map<string, Promise<string>>()

/**
 * 当前可见的相册目录：
 * - undefined：渲染进程尚未上报，兼容启动阶段的请求
 * - null：相册库首页，只需要封面缩略图
 * - string：正在浏览的相册，只需要该目录的网格/观赏缩略图
 */
let activeScope: string | null | undefined

/** 由渲染进程在进入/离开相册时调用，取消上一视图排队中的缩略图任务 */
export function setThumbnailScope(albumPath: string | null): void {
  activeScope = albumPath === null ? null : normalizePath(albumPath)
  limiter.dropInactive(isScopeActive)
}

function isScopeActive(scope: string, priority: ThumbPriority): boolean {
  if (activeScope === undefined) return true
  if (activeScope === null) return priority === 'cover'
  return priority !== 'cover' && scope === activeScope
}

function scopeOf(file: PhotoFile): string {
  // 目前只扫描相册目录顶层，照片的父目录就是相册目录
  return normalizePath(path.dirname(file.path))
}

/** 必须在 app ready 之前调用 */
export function registerThumbScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ])
}

export function installThumbProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== THUMB_HOST) return notFound()

      const id = decodeURIComponent(url.pathname.replace(/^\//, ''))
      if (!id) return notFound()

      const file = getPhotoFile(id)
      if (!file) return notFound()

      const width = pickWidth(url.searchParams.get('w'))
      const priority = pickPriority(url.searchParams.get('p'), width)
      const thumbPath = await ensureThumbnail(file, width, priority)
      const data = await fs.readFile(thumbPath)
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': 'image/webp',
          // URL 中带 mtime 版本号，可以放心长缓存
          'Cache-Control': 'public, max-age=31536000, immutable'
        }
      })
    } catch (error) {
      // 切换视图时主动取消的请求属于正常情况，不打印错误
      if (!(error instanceof ThumbnailDroppedError)) {
        console.error('[thumbnail] failed:', request.url, error)
      }
      return notFound()
    }
  })
}

function notFound(): Response {
  return new Response(null, { status: 404 })
}

function pickWidth(raw: string | null): number {
  const requested = Number(raw)
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_WIDTH
  return WIDTH_BUCKETS.find((bucket) => bucket >= requested) ?? WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1]
}

function pickPriority(raw: string | null, width: number): ThumbPriority {
  if (raw === 'view' || raw === 'grid' || raw === 'cover') return raw
  // 兼容没有 p 参数的旧 URL
  if (width >= 960) return 'view'
  if (width >= 480) return 'cover'
  return 'grid'
}

function cacheKey(file: PhotoFile, width: number): string {
  return crypto
    .createHash('sha1')
    .update(`${file.path}|${file.mtimeMs}|${file.size}|${width}|${CACHE_VERSION}`)
    .digest('hex')
}

async function ensureThumbnail(
  file: PhotoFile,
  width: number,
  priority: ThumbPriority
): Promise<string> {
  const key = cacheKey(file, width)
  const cachePath = path.join(app.getPath('userData'), 'thumbnails', key.slice(0, 2), `${key}.webp`)

  const pending = inFlight.get(key)
  if (pending) return pending

  try {
    await fs.access(cachePath)
    return cachePath
  } catch {
    // 缓存不存在，继续生成
  }

  const scope = scopeOf(file)
  // 刚切走的视图可能还有少量请求在路上，直接放弃
  if (!isScopeActive(scope, priority)) throw new ThumbnailDroppedError()

  const task = limiter
    .run(priority, scope, async () => {
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      const input = await loadImageInput(file.path)
      await sharp(input)
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(cachePath)
      return cachePath
    })
    .finally(() => inFlight.delete(key))

  inFlight.set(key, task)
  return task
}

/** NEF 无法被 sharp 直接解码，改为提取相机写入的内嵌 JPEG/PNG 预览 */
async function loadImageInput(filePath: string): Promise<string | Buffer> {
  if (path.extname(filePath).toLowerCase() !== '.nef') {
    return filePath
  }

  const preview = await extractThumbnail(filePath)
  if (!preview.found) {
    throw new Error(`NEF 没有可用的内嵌预览：${preview.reason}`)
  }
  return Buffer.from(preview.data)
}
