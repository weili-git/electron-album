import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AddAlbumsResult, Album, AlbumStats, Photo } from '../shared/types'
import { computeAlbumStats, removeAlbumExifCache } from './exifStats'
import {
  getAlbumScan,
  getAlbumSummaryForLibrary,
  photosOfScan,
  revalidateAlbum,
  type AlbumSummary
} from './photos'
import { removeCachedScan } from './scanCache'
import { mapLimit, normalizePath } from './util'

/** 持久化结构：路径与名称分开存储，名称默认取文件夹名，后续可重命名 */
interface AlbumRecord {
  id: string
  path: string
  name: string
  addedAt: number
}

interface LibraryFile {
  version: number
  albums: AlbumRecord[]
}

const LIBRARY_VERSION = 1
const SCAN_CONCURRENCY = 4

let records: AlbumRecord[] = []
let loaded = false
let persistQueue: Promise<void> = Promise.resolve()

type PhotosUpdatedHandler = (albumId: string, photos: Photo[]) => void
let photosUpdatedHandler: PhotosUpdatedHandler | null = null

export type StatsProgressListener = (processed: number, total: number) => void

interface StatsJob {
  promise: Promise<AlbumStats>
  listeners: Set<StatsProgressListener>
}

/** 同一相册的统计只跑一次；面板关闭后重开可以复用正在进行的任务 */
const statsJobs = new Map<string, StatsJob>()

/** 后台重扫发现照片变化时，由主进程转发给渲染进程 */
export function setPhotosUpdatedHandler(handler: PhotosUpdatedHandler | null): void {
  photosUpdatedHandler = handler
}

function libraryFile(): string {
  return path.join(app.getPath('userData'), 'library.json')
}

function albumId(filePath: string): string {
  return crypto.createHash('sha1').update(normalizePath(filePath)).digest('hex').slice(0, 16)
}

function toAlbum(record: AlbumRecord, summary: AlbumSummary): Album {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    addedAt: record.addedAt,
    photoCount: summary.photoCount,
    coverThumbs: summary.coverThumbs,
    missing: summary.missing
  }
}

function isAlbumRecord(value: unknown): value is AlbumRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.path === 'string'
}

export async function loadLibrary(): Promise<void> {
  if (loaded) return
  loaded = true

  try {
    const raw = await fs.readFile(libraryFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LibraryFile>
    if (!Array.isArray(parsed.albums)) return

    records = parsed.albums.filter(isAlbumRecord).map((record) => ({
      id: record.id,
      path: record.path,
      name: typeof record.name === 'string' && record.name ? record.name : path.basename(record.path),
      addedAt: Number(record.addedAt) || Date.now()
    }))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error('[library] failed to load library.json:', error)
    }
  }
}

/** 串行写入，避免并发写坏文件 */
function persist(): Promise<void> {
  const snapshot: LibraryFile = { version: LIBRARY_VERSION, albums: records }
  const serialized = JSON.stringify(snapshot, null, 2)

  persistQueue = persistQueue
    .then(async () => {
      const file = libraryFile()
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tempFile = `${file}.${process.pid}.tmp`
      await fs.writeFile(tempFile, serialized, 'utf8')
      await fs.rename(tempFile, file)
    })
    .catch((error) => {
      console.error('[library] failed to save library.json:', error)
    })

  return persistQueue
}

/** 读取相册库，并刷新每个相册的照片数与封面（优先使用扫描缓存） */
export async function getAlbums(): Promise<Album[]> {
  return mapLimit(records, SCAN_CONCURRENCY, async (record) => {
    const summary = await getAlbumSummaryForLibrary(record.path)
    return toAlbum(record, summary)
  })
}

export async function addAlbums(paths: string[]): Promise<AddAlbumsResult> {
  const existing = new Set(records.map((record) => normalizePath(record.path)))
  let added = 0
  let skipped = 0

  for (const rawPath of paths) {
    const resolved = path.resolve(rawPath)
    const normalized = normalizePath(resolved)
    if (existing.has(normalized)) {
      skipped += 1
      continue
    }
    existing.add(normalized)
    records.push({
      id: albumId(resolved),
      path: resolved,
      name: path.basename(resolved) || resolved,
      addedAt: Date.now()
    })
    added += 1
  }

  if (added > 0) {
    await persist()
  }

  return { albums: await getAlbums(), added, skipped }
}

export async function removeAlbum(id: string): Promise<Album[]> {
  const removed = records.find((record) => record.id === id)
  records = records.filter((record) => record.id !== id)
  if (removed) {
    removeCachedScan(removed.path)
    removeAlbumExifCache(id)
    await persist()
  }
  return getAlbums()
}

export async function listPhotos(albumId: string): Promise<Photo[]> {
  const record = records.find((item) => item.id === albumId)
  if (!record) return []

  // 先返回缓存，界面立刻可见；随后在后台校验并推送变化
  const scan = await getAlbumScan(record.path)
  void revalidateAlbum(record.path)
    .then((updated) => {
      if (updated && photosUpdatedHandler) {
        photosUpdatedHandler(albumId, photosOfScan(updated))
      }
    })
    .catch((error) => {
      console.error('[library] failed to revalidate album:', record.path, error)
    })

  return photosOfScan(scan)
}

/**
 * 按需计算相册的 EXIF 统计：首次逐张解析，之后走 per-album 缓存。
 * 进度回调按相册广播；同一相册的并发请求共用一次计算。
 */
export function getAlbumStats(
  albumId: string,
  listener: StatsProgressListener
): Promise<AlbumStats | null> {
  const record = records.find((item) => item.id === albumId)
  if (!record) return Promise.resolve(null)

  const existing = statsJobs.get(albumId)
  if (existing) {
    existing.listeners.add(listener)
    return existing.promise
  }

  const listeners = new Set([listener])
  const onProgress = (processed: number, total: number): void => {
    for (const notify of listeners) notify(processed, total)
  }

  const promise = getAlbumScan(record.path).then((scan) =>
    computeAlbumStats(albumId, scan.photos, onProgress)
  )
  const job: StatsJob = { promise, listeners }
  statsJobs.set(albumId, job)
  const cleanup = (): void => {
    if (statsJobs.get(albumId) === job) statsJobs.delete(albumId)
  }
  promise.then(cleanup, cleanup)

  return promise
}
