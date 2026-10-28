import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AddAlbumsResult, Album, AlbumStats, Photo } from '../shared/types'
import { computeAlbumStats, removeAlbumExifCache } from './exifStats'
import {
  GearScanJob,
  pruneGearCache,
  removeGearCache,
  type GearSnapshotListener
} from './gear'
import {
  removeAlbumSimilarCache,
  SimilarAnalysisJob,
  type SimilarSnapshotListener
} from './similarity'
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

/** 相似分析按相册合并；任务会持续推送渐进分组，暂停后从缓存继续 */
const similarJobs = new Map<string, SimilarAnalysisJob>()
/** 防止 start 扫描期间用户已经暂停，扫描结束后又启动旧任务 */
const similarStartTokens = new Map<string, number>()

/** 设备库扫描一次只跑一个任务，离开设备库页面时暂停 */
let gearJob: GearScanJob | null = null
/** 防止暂停后旧的扫描任务又被新的 start 复用 */
let gearStartToken = 0

function nextSimilarToken(albumId: string): number {
  const token = (similarStartTokens.get(albumId) ?? 0) + 1
  similarStartTokens.set(albumId, token)
  return token
}

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
    await pauseSimilarAnalysis(id)
    removeCachedScan(removed.path)
    removeAlbumExifCache(id)
    removeAlbumSimilarCache(id)
    removeGearCache(id)
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

/**
 * 开始或继续相册的相似分析。已有任务直接复用并补发最新快照；
 * 只处理当前视口窗口，滚动到哪分析到哪，不主动全量扫描。
 */
export function startSimilarAnalysis(
  albumId: string,
  listener: SimilarSnapshotListener
): Promise<void> {
  const record = records.find((item) => item.id === albumId)
  if (!record) return Promise.resolve()

  const existing = similarJobs.get(albumId)
  if (existing) {
    existing.addListener(listener)
    return Promise.resolve()
  }

  const token = nextSimilarToken(albumId)
  return getAlbumScan(record.path).then((scan) => {
    // 扫描期间可能已经暂停或发起了新的 start，旧请求直接丢弃
    if (similarStartTokens.get(albumId) !== token) return

    const current = similarJobs.get(albumId)
    if (current) {
      current.addListener(listener)
      return
    }

    const job = new SimilarAnalysisJob(albumId, scan.photos)
    job.addListener(listener)
    similarJobs.set(albumId, job)
    void job.start()
  })
}

/** 停止并保存当前相册已经计算出的指纹；再次开始会复用缓存 */
export async function pauseSimilarAnalysis(albumId: string): Promise<void> {
  // 使仍在扫描/排队中的 start 失效
  nextSimilarToken(albumId)
  const job = similarJobs.get(albumId)
  if (!job) return
  similarJobs.delete(albumId)
  await job.pause()
}

/** 当前可见范围变化时，重划任务的分析窗口 */
export function setSimilarViewport(albumId: string, start: number, end: number): void {
  similarJobs.get(albumId)?.setViewport(start, end)
}

/** 观赏窗口/细看层打开时让分析让路，关闭后自动继续 */
export function setSimilarForeground(albumId: string, foreground: boolean): void {
  similarJobs.get(albumId)?.setForeground(foreground)
}

/**
 * 开始设备库扫描：先校验缓存并立即推送，再逐本补齐待读相册。
 * refresh 会忽略已有样本重新读取；正在扫描时先暂停旧任务。
 */
export async function startGearScan(
  listener: GearSnapshotListener,
  refresh = false
): Promise<void> {
  if (gearJob) {
    if (!refresh) {
      gearJob.addListener(listener)
      return
    }
    gearJob.addListener(listener)
    await pauseGearScan()
    // 暂停期间可能已经有新的 start 创建了任务，直接复用
    if (gearJob) {
      gearJob.addListener(listener)
      return
    }
  }

  pruneGearCache(new Set(records.map((record) => record.id)))

  const token = (gearStartToken += 1)
  const job = new GearScanJob(
    records.map(({ id, path: albumPath, name }) => ({ id, path: albumPath, name })),
    listener,
    refresh
  )
  gearJob = job
  void job.start().finally(() => {
    if (gearJob === job && gearStartToken === token) gearJob = null
  })
}

/** 离开设备库页面时暂停；当前相册读完后停止并保存样本 */
export async function pauseGearScan(): Promise<void> {
  gearStartToken += 1
  const job = gearJob
  if (!job) return
  gearJob = null
  await job.pause()
}
