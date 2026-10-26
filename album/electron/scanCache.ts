import { app } from 'electron'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { normalizePath } from './util'

/** 缓存中的单张照片元数据；真实路径由相册目录 + name 推导 */
export interface CachedPhoto {
  name: string
  createdAt: number
  mtimeMs: number
  size: number
}

export interface CachedScan {
  /** 相册目录的原始路径 */
  dir: string
  /** 扫描时目录的 mtime，用于快速判断增删/改名 */
  dirMtimeMs: number | null
  missing: boolean
  /** 最近一次扫描完成时间，用于后台重新校验的节流 */
  scannedAt: number
  photos: CachedPhoto[]
}

interface CacheFile {
  version: number
  entries: CachedScan[]
}

const CACHE_VERSION = 1
const WRITE_DEBOUNCE_MS = 800

let entries = new Map<string, CachedScan>()
let loaded = false
let dirty = false
let writeTimer: ReturnType<typeof setTimeout> | null = null
let writeQueue: Promise<void> = Promise.resolve()
/** 异步写入与退出时的同步写入可能重叠，用独立临时文件避免互相干扰 */
let writeSequence = 0

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'scan-cache.json')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isCachedPhoto(value: unknown): value is CachedPhoto {
  if (!value || typeof value !== 'object') return false
  const photo = value as Record<string, unknown>
  return (
    typeof photo.name === 'string' &&
    photo.name.length > 0 &&
    isFiniteNumber(photo.createdAt) &&
    isFiniteNumber(photo.mtimeMs) &&
    isFiniteNumber(photo.size)
  )
}

function isCachedScan(value: unknown): value is CachedScan {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.dir === 'string' &&
    entry.dir.length > 0 &&
    (entry.dirMtimeMs === null || isFiniteNumber(entry.dirMtimeMs)) &&
    typeof entry.missing === 'boolean' &&
    isFiniteNumber(entry.scannedAt) &&
    Array.isArray(entry.photos) &&
    entry.photos.every(isCachedPhoto)
  )
}

export async function loadScanCache(): Promise<void> {
  if (loaded) return
  loaded = true

  try {
    const raw = await fs.readFile(cacheFile(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CacheFile>
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return

    for (const entry of parsed.entries) {
      if (!isCachedScan(entry)) continue
      entries.set(normalizePath(entry.dir), entry)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error('[scan-cache] failed to load scan-cache.json:', error)
    }
  }
}

export function getCachedScan(dir: string): CachedScan | undefined {
  return entries.get(normalizePath(dir))
}

export function setCachedScan(entry: CachedScan): void {
  entries.set(normalizePath(entry.dir), entry)
  dirty = true
  scheduleWrite()
}

export function removeCachedScan(dir: string): void {
  if (!entries.delete(normalizePath(dir))) return
  dirty = true
  scheduleWrite()
}

export function isScanFresh(entry: CachedScan, ttlMs: number): boolean {
  return Date.now() - entry.scannedAt < ttlMs
}

function serialize(): string {
  const snapshot: CacheFile = {
    version: CACHE_VERSION,
    entries: Array.from(entries.values())
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
    void flushScanCache()
  }, WRITE_DEBOUNCE_MS)
}

/** 串行写入，避免后台重扫并发时写坏文件 */
export function flushScanCache(): Promise<void> {
  if (!dirty) return writeQueue
  dirty = false
  const serialized = serialize()

  writeQueue = writeQueue
    .then(async () => {
      const file = cacheFile()
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tempFile = tempFileFor(file)
      await fs.writeFile(tempFile, serialized, 'utf8')
      await fs.rename(tempFile, file)
    })
    .catch((error) => {
      console.error('[scan-cache] failed to save scan-cache.json:', error)
    })

  return writeQueue
}

/** 退出时同步落盘，避免最后一批扫描结果丢失 */
export function flushScanCacheSync(): void {
  if (!dirty) return
  dirty = false
  try {
    const file = cacheFile()
    fsSync.mkdirSync(path.dirname(file), { recursive: true })
    const tempFile = tempFileFor(file)
    fsSync.writeFileSync(tempFile, serialize(), 'utf8')
    fsSync.renameSync(tempFile, file)
  } catch (error) {
    console.error('[scan-cache] failed to save scan-cache.json on quit:', error)
  }
}
