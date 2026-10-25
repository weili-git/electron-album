import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AddAlbumsResult, Album, Photo } from '../shared/types'
import { coverThumbsOf, scanAlbum, scanAlbumPhotos, type AlbumScan } from './photos'
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

function libraryFile(): string {
  return path.join(app.getPath('userData'), 'library.json')
}

function albumId(filePath: string): string {
  return crypto.createHash('sha1').update(normalizePath(filePath)).digest('hex').slice(0, 16)
}

function toAlbum(record: AlbumRecord, scan: AlbumScan): Album {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    addedAt: record.addedAt,
    photoCount: scan.photos.length,
    coverThumbs: coverThumbsOf(scan.photos),
    missing: scan.missing
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

/** 读取相册库，并刷新每个相册的照片数与封面 */
export async function getAlbums(): Promise<Album[]> {
  return mapLimit(records, SCAN_CONCURRENCY, async (record) => {
    const scan = await scanAlbum(record.path)
    return toAlbum(record, scan)
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
  records = records.filter((record) => record.id !== id)
  await persist()
  return getAlbums()
}

export async function listPhotos(albumId: string): Promise<Photo[]> {
  const record = records.find((item) => item.id === albumId)
  if (!record) return []
  return scanAlbumPhotos(record.path)
}
