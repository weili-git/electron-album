import { app, net, protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { extractThumbnail } from 'extract-raw-preview'
import { getPhotoFile, GRID_THUMB_WIDTH, photoId, type PhotoFile } from './photos'
import { normalizePath } from './util'

const SCHEME = 'thumb'
const THUMB_HOST = 'photo'
const CACHE_VERSION = 'v1'
/** 缩略图宽度档位，避免任意宽度导致缓存膨胀 */
const WIDTH_BUCKETS = [160, 320, 480, 640, 960, 1280, 1920]
const DEFAULT_WIDTH = GRID_THUMB_WIDTH
/** 兼顾吞吐与风扇/磁盘压力，最多 8 个并发生成 */
const MAX_CONCURRENCY = Math.max(4, Math.min(8, os.availableParallelism()))
/** 每个 sharp 任务内部单线程，避免与外部并发叠加造成 CPU 超订 */
sharp.concurrency(1)

/**
 * 缩略图用途：观赏窗口 > 屏幕内网格/分析 > 分析预读 > 其余网格 > 相册封面。
 * 分析只复用网格缩略图，因此它和显示请求是同一份任务，不会再解码一次原图；
 * 把分析排在普通网格之前，快速滚动时跳过的行不会拖住分析窗口。
 */
type ThumbPriority = 'view' | 'grid' | 'analysis' | 'cover'
const PRIORITY_ORDER: ThumbPriority[] = ['view', 'grid', 'analysis', 'cover']

class ThumbnailDroppedError extends Error {
  constructor() {
    super('thumbnail request no longer visible')
    this.name = 'ThumbnailDroppedError'
  }
}

interface QueueEntry {
  /** 照片所属相册目录，用于切换视图时丢弃旧任务 */
  scope: string
  /** 照片 id，用于让屏幕内照片优先于快速滚动时跳过的行 */
  photoId?: string
  start: () => void
  reject: (error: unknown) => void
}

class ThumbnailQueue {
  private active = 0
  private readonly queues: Record<ThumbPriority, QueueEntry[]> = {
    view: [],
    grid: [],
    analysis: [],
    cover: []
  }
  /** 当前屏幕（真实可视区）内的照片 id；由渲染进程滚动后上报 */
  private visible = new Set<string>()

  constructor(private readonly max: number) {}

  setVisible(ids: Iterable<string>): void {
    this.visible = new Set(ids)
  }

  clearVisible(): void {
    this.visible.clear()
  }

  run<T>(
    priority: ThumbPriority,
    scope: string,
    task: () => Promise<T>,
    photoId?: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        scope,
        photoId,
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
    // 观赏窗口的请求永远最先处理
    const view = this.queues.view.shift()
    if (view) {
      view.start()
      return
    }

    // 屏幕内照片优先：分析预读的照片滚进屏幕后也要立刻提到前面
    const visible = this.takeVisible('grid') ?? this.takeVisible('analysis')
    if (visible) {
      visible.start()
      return
    }

    // 分析预读窗口先于快速滚动时跳过的行；那些行等滚回来再生成
    const analysis = this.queues.analysis.shift()
    if (analysis) {
      analysis.start()
      return
    }

    const grid = this.queues.grid.shift()
    if (grid) {
      grid.start()
      return
    }

    this.queues.cover.shift()?.start()
  }

  private takeVisible(priority: ThumbPriority): QueueEntry | undefined {
    const queue = this.queues[priority]
    if (queue.length === 0 || this.visible.size === 0) return undefined
    const index = queue.findIndex((entry) => entry.photoId && this.visible.has(entry.photoId))
    return index >= 0 ? queue.splice(index, 1)[0] : undefined
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
  limiter.clearVisible()
  limiter.dropInactive(isScopeActive)
}

/** 渲染进程上报真实可视区内的照片 id，网格缩略图优先处理这些照片 */
export function setThumbnailViewport(ids: string[]): void {
  limiter.setVisible(ids)
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

      // 细看层直接读取原图，不经过缩放缓存
      if (url.searchParams.get('original') === '1') {
        return serveOriginal(file)
      }

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

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

/** Chromium 可直接解码的格式；其余格式需要转换后再返回 */
const DIRECT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

/**
 * 细看层 / 未来编辑层使用的原图。
 * JPG/PNG/WebP/GIF 直接流式返回原文件；NEF 返回内嵌预览；TIFF 转成原始像素的 PNG。
 */
async function serveOriginal(file: PhotoFile): Promise<Response> {
  const ext = path.extname(file.path).toLowerCase()

  if (ext === '.nef') {
    const preview = await extractThumbnail(file.path, { prefer: 'largest' })
    if (!preview.found || !preview.decodable) return notFound()
    return binaryResponse(new Uint8Array(preview.data), preview.mimeType)
  }

  if (ext === '.tif' || ext === '.tiff') {
    // 浏览器不能直接显示 TIFF，按原始像素解码后转成 PNG
    const png = await sharp(file.path).rotate().png().toBuffer()
    return binaryResponse(new Uint8Array(png), 'image/png')
  }

  const response = await net.fetch(pathToFileURL(file.path).toString())
  if (!response.ok) return notFound()

  const headers = new Headers(response.headers)
  const mime = DIRECT_MIME[ext] ?? headers.get('Content-Type')
  if (mime) headers.set('Content-Type', mime)
  headers.set('Cache-Control', IMMUTABLE_CACHE)
  return new Response(response.body, { status: response.status, headers })
}

function binaryResponse(data: Uint8Array<ArrayBuffer>, mime: string): Response {
  return new Response(data, {
    headers: {
      'Content-Type': mime,
      'Cache-Control': IMMUTABLE_CACHE
    }
  })
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

  const id = photoId(file.path)
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
    }, id)
    .finally(() => inFlight.delete(key))

  inFlight.set(key, task)
  return task
}

/**
 * 相似分析复用网格缩略图：宽度与网格一致，共用磁盘缓存与 inFlight 去重，
 * 因此不会为了算哈希再解码一次原图。任务以 analysis 优先级排队。
 */
export function getAnalysisThumbnail(file: PhotoFile): Promise<string> {
  return ensureThumbnail(file, GRID_THUMB_WIDTH, 'analysis')
}

/**
 * 切换相册/视图时排队中的缩略图任务会被主动取消。
 * 分析侧需要把它和“图片无法解码”区分开，避免把取消误记成坏图。
 */
export function isThumbnailDropped(error: unknown): boolean {
  return error instanceof ThumbnailDroppedError
}

/**
 * NEF 无法被 sharp 直接解码，改为提取相机写入的内嵌 JPEG/PNG 预览。
 * 相似照片分析复用所生成的缩略图，因此 RAW 与网格看到的是同一张图。
 */
async function loadImageInput(filePath: string): Promise<string | Buffer> {
  if (path.extname(filePath).toLowerCase() !== '.nef') {
    return filePath
  }

  const preview = await extractThumbnail(filePath, { prefer: 'largest' })
  if (!preview.found) {
    throw new Error(`NEF 没有可用的内嵌预览：${preview.reason}`)
  }
  return Buffer.from(preview.data)
}
