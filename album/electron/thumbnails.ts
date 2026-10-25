import { app, protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import sharp from 'sharp'
import { extractThumbnail } from 'extract-raw-preview'
import { getPhotoFile, type PhotoFile } from './photos'

const SCHEME = 'thumb'
const THUMB_HOST = 'photo'
const CACHE_VERSION = 'v1'
/** 缩略图宽度档位，避免任意宽度导致缓存膨胀 */
const WIDTH_BUCKETS = [160, 320, 480, 640, 960]
const DEFAULT_WIDTH = 320
const MAX_CONCURRENCY = 4

class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.active -= 1
    const next = this.queue.shift()
    if (next) next()
  }
}

const limiter = new Semaphore(MAX_CONCURRENCY)
const inFlight = new Map<string, Promise<string>>()

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
      const thumbPath = await ensureThumbnail(file, width)
      const data = await fs.readFile(thumbPath)
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': 'image/webp',
          // URL 中带 mtime 版本号，可以放心长缓存
          'Cache-Control': 'public, max-age=31536000, immutable'
        }
      })
    } catch (error) {
      console.error('[thumbnail] failed:', request.url, error)
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

function cacheKey(file: PhotoFile, width: number): string {
  return crypto
    .createHash('sha1')
    .update(`${file.path}|${file.mtimeMs}|${file.size}|${width}|${CACHE_VERSION}`)
    .digest('hex')
}

async function ensureThumbnail(file: PhotoFile, width: number): Promise<string> {
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

  const task = limiter
    .run(async () => {
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
