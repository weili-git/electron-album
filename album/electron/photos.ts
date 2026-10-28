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

/** RAW 扩展名：与同名可解码文件同时存在时，只展示可解码文件 */
const RAW_EXTENSIONS = new Set(['.nef'])
/** 同名组里优先展示的格式，越靠前越优先 */
const DISPLAY_PRIORITY = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff']

function extensionOf(name: string): string {
  return path.extname(name).toLowerCase()
}

function displayRank(name: string): number {
  const index = DISPLAY_PRIORITY.indexOf(extensionOf(name))
  return index === -1 ? DISPLAY_PRIORITY.length : index
}

/**
 * RAW+JPEG 同名文件（如 DSC_1880.JPG 与 DSC_1880.NEF）只保留一张用于展示：
 * 优先 JPG，其次其他可解码格式，RAW 不参与展示。
 * 没有 RAW 参与的同名文件（如 JPG + PNG）保持原样，避免误伤同名的不同图片。
 * 既用于扫描前裁剪候选（省掉被隐藏 RAW 的 stat 与后续缩略图/相似分析），
 * 也用于兼容旧扫描缓存（缓存中可能仍保留成对的文件）。
 */
export function dedupeRawPairs<T extends { name: string }>(photos: T[]): T[] {
  if (photos.length < 2) return photos

  const groups = new Map<string, T[]>()
  for (const photo of photos) {
    const stem = path.basename(photo.name, path.extname(photo.name)).toLowerCase()
    const group = groups.get(stem)
    if (group) group.push(photo)
    else groups.set(stem, [photo])
  }

  const dropped = new Set<T>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    if (!group.some((photo) => RAW_EXTENSIONS.has(extensionOf(photo.name)))) continue

    const display = group
      .filter((photo) => !RAW_EXTENSIONS.has(extensionOf(photo.name)))
      .sort((a, b) => displayRank(a.name) - displayRank(b.name))[0]
    if (!display) continue

    for (const photo of group) {
      if (photo !== display) dropped.add(photo)
    }
  }

  return dropped.size === 0 ? photos : photos.filter((photo) => !dropped.has(photo))
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
  const photos = dedupeRawPairs(entry.photos).map((cached) =>
    registerPhoto(toPhotoFile(entry.dir, cached))
  )
  return { photos, missing: entry.missing }
}

/** 真实扫描目录顶层；不读取图片内容。register=false 时只返回元数据，不登记 registry */
async function scanAlbumFiles(dir: string, register = true): Promise<ScanResult> {
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

  const candidates = dedupeRawPairs(
    entries.filter(
      (entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    )
  )

  const photos = await mapLimit(candidates, 16, async (entry): Promise<PhotoFile | null> => {
    const filePath = path.join(dir, entry.name)
    try {
      const stat = await fs.stat(filePath)
      if (!stat.isFile()) return null
      const createdAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
      const photo: PhotoFile = {
        path: filePath,
        name: entry.name,
        createdAt,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      }
      return register ? registerPhoto(photo) : photo
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
  // 旧缓存的照片列表里可能还留着成对的 RAW，先按当前规则收缩再比较
  const cachedPhotos = dedupeRawPairs(cached.photos)
  if (cachedPhotos.length !== scan.photos.length) return true

  for (let index = 0; index < scan.photos.length; index += 1) {
    const a = cachedPhotos[index]
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
  const photos = dedupeRawPairs(entry.photos)
  return {
    photoCount: photos.length,
    missing: entry.missing,
    coverThumbs: photos.slice(0, 3).map((cached) => {
      const photo = registerPhoto(toPhotoFile(entry.dir, cached))
      return makeThumbUrl(photoId(photo.path), 480, photo.mtimeMs, 'cover')
    })
  }
}

/** 设备库采样需要的轻量相册信息：只登记封面照片，不把整本照片放进 registry */
export interface AlbumSampleSource {
  dir: string
  missing: boolean
  photoCount: number
  coverThumbs: string[]
  /** 全部照片的轻量元数据，未登记 registry */
  photos: CachedPhoto[]
}

function coverThumbsFor(photos: PhotoFile[]): string[] {
  return photos
    .slice(0, 3)
    .map((photo) => makeThumbUrl(photoId(photo.path), 480, photo.mtimeMs, 'cover'))
}

/**
 * 设备库按相册前几张照片归类时使用：
 * 返回全部照片元数据供按位置采样，但只登记前 3 张封面，避免整库进入 registry。
 */
export async function getAlbumSampleSource(
  dir: string,
  force = false
): Promise<AlbumSampleSource> {
  const cached = !force ? getCachedScan(dir) : undefined
  if (cached) {
    const signature = await readDirSignature(dir)
    if (matchesSignature(cached, signature)) {
      const photos = dedupeRawPairs(cached.photos)
      const coverPhotos = photos
        .slice(0, 3)
        .map((photo) => registerPhoto(toPhotoFile(cached.dir, photo)))
      return {
        dir: cached.dir,
        missing: cached.missing,
        photoCount: photos.length,
        coverThumbs: coverThumbsFor(coverPhotos),
        photos
      }
    }
  }

  const scan = await scanAlbumFiles(dir, false)
  cacheScan(dir, scan)
  const coverPhotos = scan.photos.slice(0, 3).map((photo) => registerPhoto(photo))
  return {
    dir,
    missing: scan.missing,
    photoCount: scan.photos.length,
    coverThumbs: coverThumbsFor(coverPhotos),
    photos: scan.photos.map(toCachedPhoto)
  }
}

/** 把采样选中的照片登记到 registry，供缩略图/EXIF 读取使用 */
export function registerAlbumSample(source: AlbumSampleSource, index: number): PhotoFile | null {
  const cached = source.photos[index]
  if (!cached) return null
  return registerPhoto(toPhotoFile(source.dir, cached))
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
