import { app } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

/**
 * 照片收藏只写入应用自己的 userData/favorites.json，不改动任何照片文件。
 * key 为照片 id（规范化路径的 sha1），与缩略图、EXIF 统计、相似分析共用。
 * 相册被移除或文件暂时不可用时保留记录；同一目录重新加入后 id 不变，收藏会自动恢复。
 */
interface FavoriteEntry {
  addedAt: number
}

interface FavoritesFile {
  version: number
  photos: Record<string, FavoriteEntry>
}

const FILE_VERSION = 1
const WRITE_DEBOUNCE_MS = 300
/** 单次操作的照片数量上限，避免异常的 IPC 请求写入超大文件 */
const MAX_BATCH = 100000

let photos = new Map<string, FavoriteEntry>()
let loaded = false
let dirty = false
let writeTimer: ReturnType<typeof setTimeout> | null = null
let writeQueue: Promise<void> = Promise.resolve()
/** 异步写入与退出时的同步写入可能重叠，用独立临时文件避免互相干扰 */
let writeSequence = 0

function favoritesFile(): string {
  return path.join(app.getPath('userData'), 'favorites.json')
}

function isFavoriteEntry(value: unknown): value is FavoriteEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.addedAt === 'number' && Number.isFinite(entry.addedAt)
}

export async function loadFavorites(): Promise<void> {
  if (loaded) return
  loaded = true

  try {
    const raw = await fs.readFile(favoritesFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<FavoritesFile>
    if (
      parsed.version !== FILE_VERSION ||
      !parsed.photos ||
      typeof parsed.photos !== 'object' ||
      Array.isArray(parsed.photos)
    ) {
      return
    }

    for (const [id, entry] of Object.entries(parsed.photos)) {
      if (id.length > 0 && isFavoriteEntry(entry)) photos.set(id, entry)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error('[favorites] failed to load favorites.json:', error)
    }
  }
}

export function listFavorites(): string[] {
  return Array.from(photos.keys())
}

/** 批量设置收藏状态；返回更新后的全部收藏 id */
export function setFavorites(photoIds: string[], favorite: boolean): string[] {
  if (photoIds.length > MAX_BATCH) {
    throw new Error('收藏操作的照片数量过多')
  }

  const now = Date.now()
  let changed = false

  for (const id of photoIds) {
    if (typeof id !== 'string' || id.length === 0) continue
    if (favorite) {
      if (!photos.has(id)) {
        photos.set(id, { addedAt: now })
        changed = true
      }
    } else if (photos.delete(id)) {
      changed = true
    }
  }

  if (changed) {
    dirty = true
    scheduleWrite()
  }
  return listFavorites()
}

function serialize(): string {
  const snapshot: FavoritesFile = {
    version: FILE_VERSION,
    photos: Object.fromEntries(photos)
  }
  return JSON.stringify(snapshot)
}

function tempFileFor(file: string): string {
  writeSequence += 1
  return `${file}.${process.pid}.${writeSequence}.tmp`
}

function scheduleWrite(): void {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    void flushFavorites()
  }, WRITE_DEBOUNCE_MS)
}

/** 串行写入，保证收藏快速连续点击时不会写坏文件 */
export function flushFavorites(): Promise<void> {
  if (!dirty) return writeQueue
  dirty = false
  const serialized = serialize()

  writeQueue = writeQueue
    .then(async () => {
      const file = favoritesFile()
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tempFile = tempFileFor(file)
      await fs.writeFile(tempFile, serialized, 'utf8')
      await fs.rename(tempFile, file)
    })
    .catch((error) => {
      console.error('[favorites] failed to save favorites.json:', error)
    })

  return writeQueue
}

/** 退出时同步落盘，避免最后一次收藏操作丢失 */
export function flushFavoritesSync(): void {
  if (!dirty) return
  dirty = false
  try {
    const file = favoritesFile()
    fsSync.mkdirSync(path.dirname(file), { recursive: true })
    const tempFile = tempFileFor(file)
    fsSync.writeFileSync(tempFile, serialize(), 'utf8')
    fsSync.renameSync(tempFile, file)
  } catch (error) {
    console.error('[favorites] failed to save favorites.json on quit:', error)
  }
}
