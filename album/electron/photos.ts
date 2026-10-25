import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Photo } from '../shared/types'
import { mapLimit, normalizePath } from './util'

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

export interface PhotoFile {
  path: string
  name: string
  createdAt: number
  mtimeMs: number
  size: number
}

/** id -> 文件信息，仅包含本次会话扫描过的相册内文件 */
const registry = new Map<string, PhotoFile>()

function photoId(filePath: string): string {
  return crypto.createHash('sha1').update(normalizePath(filePath)).digest('hex').slice(0, 20)
}

/** 生成缩略图协议 URL；v 参数用于文件内容变化后绕过浏览器缓存 */
export function makeThumbUrl(id: string, width: number, version: number): string {
  return `thumb://${THUMB_HOST}/${id}?w=${width}&v=${Math.round(version)}`
}

export function getPhotoFile(id: string): PhotoFile | undefined {
  return registry.get(id)
}

export interface AlbumScan {
  photos: PhotoFile[]
  missing: boolean
}

/**
 * 扫描相册目录顶层，按创建时间倒序排列。
 * 扫描过的文件会登记到 registry，供缩略图协议解析。
 */
export async function scanAlbum(dir: string): Promise<AlbumScan> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { photos: [], missing: true }
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
      const file: PhotoFile = {
        path: filePath,
        name: entry.name,
        createdAt,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      }
      registry.set(photoId(filePath), file)
      return file
    } catch {
      return null
    }
  })

  const sorted = photos
    .filter((photo): photo is PhotoFile => photo !== null)
    .sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }))

  return { photos: sorted, missing: false }
}

/** 扫描相册并转换成渲染进程使用的结构 */
export async function scanAlbumPhotos(dir: string): Promise<Photo[]> {
  const { photos } = await scanAlbum(dir)
  return photos.map((photo) => ({
    id: photoId(photo.path),
    name: photo.name,
    createdAt: photo.createdAt,
    thumbUrl: makeThumbUrl(photoId(photo.path), 320, photo.mtimeMs),
    viewUrl: makeThumbUrl(photoId(photo.path), 1920, photo.mtimeMs)
  }))
}

/** 相册封面：取创建时间最新的前 3 张 */
export function coverThumbsOf(photos: PhotoFile[]): string[] {
  return photos.slice(0, 3).map((photo) => makeThumbUrl(photoId(photo.path), 480, photo.mtimeMs))
}
