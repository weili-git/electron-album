import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Photo } from '../shared/types'
import { mapLimit, normalizePath } from './util'
import {
  getCachedScan,
  isScanFresh,
  setCachedScan,
  type CachedPhoto,
  type CachedScan
} from './scanCache'

/** 目前支持的图片扩展名；NEF 缩略图从内嵌 JPEG 预览中提取 */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.tif',
  '.tiff',
  '.nef'
])

const THUMB_HOST = 'photo'
/** 网格照片与相似分析共用的缩略图宽度 */
export const GRID_THUMB_WIDTH = 320
/** 缓存超过该时长后，打开相册会在后台重新扫描，以发现原地修改的文件 */
const REVALIDATE_TTL_MS = 5 * 60 * 1000

/** 缩略图 URL 类型：观赏 > 网格 > 相册封面；相似分析复用网格缩略图 */
export type ThumbKind = 'view' | 'grid' | 'cover'

export interface PhotoFile {
  path: string
  name: string
  createdAt: number
  mtimeMs: number
  size: number
}

/** id -> 文件信息，仅包含本次会话扫描过的相册内文件 */
const registry = new Map<string, PhotoFile>()

/** 同一相册的后台重扫只跑一次 */
const revalidating = new Map<string, Promise<AlbumScan | null>>()

/** 照片 id 只由规范化路径决定，缩略图协议与 EXIF 统计缓存共用 */
export function photoId(filePath: string): string {
  return crypto.createHash('sha1').update(normalizePath(filePath)).digest('hex').slice(0, 20)
}

/** 生成缩略图协议 URL；v 参数用于文件内容变化后绕过浏览器缓存 */
export function makeThumbUrl(
  id: string,
  width: number,
  version: number,
  kind: ThumbKind = 'grid'
): string {
  return `thumb://${THUMB_HOST}/${id}?w=${width}&v=${Math.round(version)}&p=${kind}`
}

/** 细看层直接使用原图；NEF/TIFF 由缩略图协议转换成浏览器可显示的内容 */
export function makeOriginalUrl(id: string, version: number): string {
  return `thumb://${THUMB_HOST}/${id}?original=1&v=${Math.round(version)}`
}

export function getPhotoFile(id: string): PhotoFile | undefined {
  return registry.get(id)
}

export interface AlbumScan {
  photos: PhotoFile[]
  missing: boolean
}

interface ScanResult extends AlbumScan {
  dirMtimeMs: number | null
}

function registerPhoto(photo: PhotoFile): PhotoFile {
  registry.set(photoId(photo.path), photo)
  return photo
}

function toPhotoFile(dir: string, cached: CachedPhoto): PhotoFile {
  return {
    path: path.join(dir, cached.name),
    name: cached.name,
    createdAt: cached.createdAt,
    mtimeMs: cached.mtimeMs,
    size: cached.size
  }
}

function toCachedPhoto(photo: PhotoFile): CachedPhoto {
  return {
    name: photo.name,
    createdAt: photo.createdAt,
    mtimeMs: photo.mtimeMs,
    size: photo.size
  }
}

/** 从缓存还原扫描结果，同时把文件登记到 registry 供 thumb:// 协议解析 */
function restoreScan(entry: CachedScan): AlbumScan {
  const photos = entry.photos.map((cached) => registerPhoto(toPhotoFile(entry.dir, cached)))
  return { photos, missing: entry.missing }
}

/** 真实扫描目录顶层；不读取图片内容 */
async function scanAlbumFiles(dir: string): Promise<ScanResult> {
  let dirStat
  try {
    dirStat = await fs.stat(dir)
  } catch {
    return { photos: [], missing: true, dirMtimeMs: null }
  }
  if (!dirStat.isDirectory()) {
    return { photos: [], missing: true, dirMtimeMs: null }
  }

  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    // 目录存在但不可读（如权限问题），保留目录签名避免每次重试都重新扫描
    return { photos: [], missing: true, dirMtimeMs: dirStat.mtimeMs }
  }

  const candidates = entries.filter(
    (entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
  )

  const photos = await mapLimit(candidates, 16, async (entry): Promise<PhotoFile | null> => {
    const filePath = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return null
      const createdAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
      return registerPhoto({
        path: filePath,
        name: entry.name,
        createdAt,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      })
    } catch {
      return null
    }
  })

  const sorted = photos
    .filter((photo): photo is PhotoFile => photo !== null)
    .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))

  return { photos: sorted, missing: false, dirMtimeMs: dirStat.mtimeMs }
}

function cacheScan(dir: string, scan: ScanResult): void {
  setCachedScan({
    dir,
    dirMtimeMs: scan.dirMtimeMs,
    missing: scan.missing,
    scannedAt: Date.now(),
    photos: scan.photos.map(toCachedPhoto)
  })
}

interface DirSignature {
  exists: boolean
  mtimeMs: number | null
}

async function readDirSignature(dir: string): Promise<DirSignature> {
  try {
    const stat = await fs.stat(dir)
    return { exists: stat.isDirectory(), mtimeMs: stat.mtimeMs }
  } catch {
    return { exists: false, mtimeMs: null }
  }
}

/** 目录 mtime 只能感知增删/改名，感知不到文件内容原地修改 */
function matchesSignature(entry: CachedScan, signature: DirSignature): boolean {
  if (entry.missing) {
    return !signature.exists || entry.dirMtimeMs === signature.mtimeMs
  }
  return signature.exists && entry.dirMtimeMs === signature.mtimeMs
}

function scanChanged(cached: CachedScan, scan: ScanResult): boolean {
  if (cached.missing !== scan.missing) return true
  if (cached.photos.length !== scan.photos.length) return true

  for (let index = 0; index < scan.photos.length; index += 1) {
    const a = cached.photos[index]
    const b = scan.photos[index]
    if (a.name !== b.name || a.createdAt !== b.createdAt || a.mtimeMs !== b.mtimeMs || a.size !== b.size) {
      return true
    }
  }
  return false
}

/** 打开相册时使用：有缓存立即返回，不等待磁盘 */
export async function getAlbumScan(dir: string): Promise<AlbumScan> {
  const cached = getCachedScan(dir)
  if (cached) return restoreScan(cached)

  const scan = await scanAlbumFiles(dir)
  cacheScan(dir, scan)
  return { photos: scan.photos, missing: scan.missing }
}

/** 相册库首页需要的元数据；不需要还原/登记整本相册的照片 */
export interface AlbumSummary {
  photoCount: number
  missing: boolean
  coverThumbs: string[]
}

function summaryOfScan(scan: AlbumScan): AlbumSummary {
  return {
    photoCount: scan.photos.length,
    missing: scan.missing,
    coverThumbs: scan.photos
      .slice(0, 3)
      .map((photo) => makeThumbUrl(photoId(photo.path), 480, photo.mtimeMs, 'cover'))
  }
}

/** 缓存里的照片未登记到 registry，封面缩略图仍需要 id -> 路径映射 */
function summaryOfCached(entry: CachedScan): AlbumSummary {
  return {
    photoCount: entry.photos.length,
    missing: entry.missing,
    coverThumbs: entry.photos.slice(0, 3).map((cached) => {
      const photo = registerPhoto(toPhotoFile(entry.dir, cached))
      return makeThumbUrl(photoId(photo.path), 480, photo.mtimeMs, 'cover')
    })
  }
}

/**
 * 相册库首页使用：目录签名未变时只读缓存，开销与相册数量成正比（不再随照片总数增长）；
 * 只在目录 mtime 变化（增删/改名）或缓存缺失时才同步重扫。
 */
export async function getAlbumSummaryForLibrary(dir: string): Promise<AlbumSummary> {
  const cached = getCachedScan(dir)
  if (cached) {
    const signature = await readDirSignature(dir)
    if (matchesSignature(cached, signature)) return summaryOfCached(cached)
  }

  const scan = await scanAlbumFiles(dir)
  cacheScan(dir, scan)
  return summaryOfScan(scan)
}

/**
 * 后台校验：目录签名变化或缓存过期时重扫。
 * 返回非 null 表示照片列表发生了变化（新增/删除/修改）。
 */
export function revalidateAlbum(dir: string): Promise<AlbumScan | null> {
  const key = normalizePath(dir)
  const pending = revalidating.get(key)
  if (pending) return pending

  const task = revalidate(dir).finally(() => {
    revalidating.delete(key)
  })
  revalidating.set(key, task)
  return task
}

async function revalidate(dir: string): Promise<AlbumScan | null> {
  const cached = getCachedScan(dir)
  const signature = await readDirSignature(dir)
  if (cached && matchesSignature(cached, signature) && isScanFresh(cached, REVALIDATE_TTL_MS)) {
    return null
  }

  const scan = await scanAlbumFiles(dir)
  const changed = !cached || scanChanged(cached, scan)
  cacheScan(dir, scan)
  return changed ? { photos: scan.photos, missing: scan.missing } : null
}

function toPhoto(photo: PhotoFile): Photo {
  const id = photoId(photo.path)
  return {
    id,
    name: photo.name,
    createdAt: photo.createdAt,
    thumbUrl: makeThumbUrl(id, GRID_THUMB_WIDTH, photo.mtimeMs, 'grid'),
    viewUrl: makeThumbUrl(id, 1920, photo.mtimeMs, 'view'),
    originalUrl: makeOriginalUrl(id, photo.mtimeMs)
  }
}

/** 把扫描结果转换成渲染进程使用的结构 */
export function photosOfScan(scan: AlbumScan): Photo[] {
  return scan.photos.map(toPhoto)
}
