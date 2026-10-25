var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { app, protocol, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import sharp from "sharp";
import { extractThumbnail } from "extract-raw-preview";
function normalizePath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
const IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".tif",
  ".tiff",
  ".nef"
]);
const THUMB_HOST$1 = "photo";
const registry = /* @__PURE__ */ new Map();
function photoId(filePath) {
  return crypto.createHash("sha1").update(normalizePath(filePath)).digest("hex").slice(0, 20);
}
function makeThumbUrl(id, width, version) {
  return `thumb://${THUMB_HOST$1}/${id}?w=${width}&v=${Math.round(version)}`;
}
function getPhotoFile(id) {
  return registry.get(id);
}
async function scanAlbum(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { photos: [], missing: true };
  }
  const candidates = entries.filter(
    (entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
  );
  const photos = await mapLimit(candidates, 16, async (entry) => {
    const filePath = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return null;
      const createdAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      const file = {
        path: filePath,
        name: entry.name,
        createdAt,
        mtimeMs: stat.mtimeMs,
        size: stat.size
      };
      registry.set(photoId(filePath), file);
      return file;
    } catch {
      return null;
    }
  });
  const sorted = photos.filter((photo) => photo !== null).sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }));
  return { photos: sorted, missing: false };
}
async function scanAlbumPhotos(dir) {
  const { photos } = await scanAlbum(dir);
  return photos.map((photo) => ({
    id: photoId(photo.path),
    name: photo.name,
    createdAt: photo.createdAt,
    thumbUrl: makeThumbUrl(photoId(photo.path), 320, photo.mtimeMs)
  }));
}
function coverThumbsOf(photos) {
  return photos.slice(0, 3).map((photo) => makeThumbUrl(photoId(photo.path), 480, photo.mtimeMs));
}
const LIBRARY_VERSION = 1;
const SCAN_CONCURRENCY = 4;
let records = [];
let loaded = false;
let persistQueue = Promise.resolve();
function libraryFile() {
  return path.join(app.getPath("userData"), "library.json");
}
function albumId(filePath) {
  return crypto.createHash("sha1").update(normalizePath(filePath)).digest("hex").slice(0, 16);
}
function toAlbum(record, scan) {
  return {
    id: record.id,
    path: record.path,
    name: record.name,
    addedAt: record.addedAt,
    photoCount: scan.photos.length,
    coverThumbs: coverThumbsOf(scan.photos),
    missing: scan.missing
  };
}
function isAlbumRecord(value) {
  if (!value || typeof value !== "object") return false;
  const record = value;
  return typeof record.id === "string" && typeof record.path === "string";
}
async function loadLibrary() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await fs.readFile(libraryFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.albums)) return;
    records = parsed.albums.filter(isAlbumRecord).map((record) => ({
      id: record.id,
      path: record.path,
      name: typeof record.name === "string" && record.name ? record.name : path.basename(record.path),
      addedAt: Number(record.addedAt) || Date.now()
    }));
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") {
      console.error("[library] failed to load library.json:", error);
    }
  }
}
function persist() {
  const snapshot = { version: LIBRARY_VERSION, albums: records };
  const serialized = JSON.stringify(snapshot, null, 2);
  persistQueue = persistQueue.then(async () => {
    const file = libraryFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tempFile, serialized, "utf8");
    await fs.rename(tempFile, file);
  }).catch((error) => {
    console.error("[library] failed to save library.json:", error);
  });
  return persistQueue;
}
async function getAlbums() {
  return mapLimit(records, SCAN_CONCURRENCY, async (record) => {
    const scan = await scanAlbum(record.path);
    return toAlbum(record, scan);
  });
}
async function addAlbums(paths) {
  const existing = new Set(records.map((record) => normalizePath(record.path)));
  let added = 0;
  let skipped = 0;
  for (const rawPath of paths) {
    const resolved = path.resolve(rawPath);
    const normalized = normalizePath(resolved);
    if (existing.has(normalized)) {
      skipped += 1;
      continue;
    }
    existing.add(normalized);
    records.push({
      id: albumId(resolved),
      path: resolved,
      name: path.basename(resolved) || resolved,
      addedAt: Date.now()
    });
    added += 1;
  }
  if (added > 0) {
    await persist();
  }
  return { albums: await getAlbums(), added, skipped };
}
async function removeAlbum(id) {
  records = records.filter((record) => record.id !== id);
  await persist();
  return getAlbums();
}
async function listPhotos(albumId2) {
  const record = records.find((item) => item.id === albumId2);
  if (!record) return [];
  return scanAlbumPhotos(record.path);
}
const SCHEME = "thumb";
const THUMB_HOST = "photo";
const CACHE_VERSION = "v1";
const WIDTH_BUCKETS = [160, 320, 480, 640, 960];
const DEFAULT_WIDTH = 320;
const MAX_CONCURRENCY = 4;
class Semaphore {
  constructor(max) {
    __publicField(this, "active", 0);
    __publicField(this, "queue", []);
    this.max = max;
  }
  async run(task) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
  acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }
  release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
const limiter = new Semaphore(MAX_CONCURRENCY);
const inFlight = /* @__PURE__ */ new Map();
function registerThumbScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true }
    }
  ]);
}
function installThumbProtocol() {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== THUMB_HOST) return notFound();
      const id = decodeURIComponent(url.pathname.replace(/^\//, ""));
      if (!id) return notFound();
      const file = getPhotoFile(id);
      if (!file) return notFound();
      const width = pickWidth(url.searchParams.get("w"));
      const thumbPath = await ensureThumbnail(file, width);
      const data = await fs.readFile(thumbPath);
      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": "image/webp",
          // URL 中带 mtime 版本号，可以放心长缓存
          "Cache-Control": "public, max-age=31536000, immutable"
        }
      });
    } catch (error) {
      console.error("[thumbnail] failed:", request.url, error);
      return notFound();
    }
  });
}
function notFound() {
  return new Response(null, { status: 404 });
}
function pickWidth(raw) {
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_WIDTH;
  return WIDTH_BUCKETS.find((bucket) => bucket >= requested) ?? WIDTH_BUCKETS[WIDTH_BUCKETS.length - 1];
}
function cacheKey(file, width) {
  return crypto.createHash("sha1").update(`${file.path}|${file.mtimeMs}|${file.size}|${width}|${CACHE_VERSION}`).digest("hex");
}
async function ensureThumbnail(file, width) {
  const key = cacheKey(file, width);
  const cachePath = path.join(app.getPath("userData"), "thumbnails", key.slice(0, 2), `${key}.webp`);
  const pending = inFlight.get(key);
  if (pending) return pending;
  try {
    await fs.access(cachePath);
    return cachePath;
  } catch {
  }
  const task = limiter.run(async () => {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    const input = await loadImageInput(file.path);
    await sharp(input).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 82 }).toFile(cachePath);
    return cachePath;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}
async function loadImageInput(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".nef") {
    return filePath;
  }
  const preview = await extractThumbnail(filePath);
  if (!preview.found) {
    throw new Error(`NEF 没有可用的内嵌预览：${preview.reason}`);
  }
  return Buffer.from(preview.data);
}
const __filename$1 = fileURLToPath(import.meta.url);
const __dirname$1 = path.dirname(__filename$1);
let win = null;
registerThumbScheme();
const createWindow = () => {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: "本地相册",
    backgroundColor: "#141416",
    webPreferences: {
      // package.json 中 "type": "module"，preload 会被编译为 preload.mjs
      preload: path.join(__dirname$1, "preload.mjs"),
      sandbox: true
    }
  });
  win.on("closed", () => {
    win = null;
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname$1, "../dist/index.html"));
  }
};
function registerIpc() {
  ipcMain.handle("album:add", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "multiSelections"]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return addAlbums(result.filePaths);
  });
  ipcMain.handle("album:list", () => getAlbums());
  ipcMain.handle("album:remove", (_event, albumId2) => {
    if (typeof albumId2 !== "string") throw new Error("无效的相册 id");
    return removeAlbum(albumId2);
  });
  ipcMain.handle("album:photos", (_event, albumId2) => {
    if (typeof albumId2 !== "string") throw new Error("无效的相册 id");
    return listPhotos(albumId2);
  });
}
app.whenReady().then(async () => {
  await loadLibrary();
  installThumbProtocol();
  registerIpc();
  createWindow();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
