import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AlbumApi,
  AlbumStatsProgress,
  GearSnapshot,
  PhotosUpdatedEvent,
  SimilarSnapshot
} from '../shared/types'

let photosUpdatedListener: ((event: IpcRendererEvent, payload: PhotosUpdatedEvent) => void) | null = null
let statsProgressListener:
  | ((event: IpcRendererEvent, payload: AlbumStatsProgress) => void)
  | null = null
let similarSnapshotListener:
  | ((event: IpcRendererEvent, payload: SimilarSnapshot) => void)
  | null = null
let gearSnapshotListener:
  | ((event: IpcRendererEvent, payload: GearSnapshot) => void)
  | null = null

const api: AlbumApi = {
  addAlbums: () => ipcRenderer.invoke('album:add'),
  listAlbums: () => ipcRenderer.invoke('album:list'),
  removeAlbum: (id) => ipcRenderer.invoke('album:remove', id),
  listPhotos: (albumId) => ipcRenderer.invoke('album:photos', albumId),
  setThumbnailScope: (albumPath) => ipcRenderer.invoke('thumb:set-scope', albumPath),
  setThumbnailViewport: (photoIds) => ipcRenderer.invoke('thumb:set-viewport', photoIds),
  getAlbumStats: (albumId) => ipcRenderer.invoke('album:stats', albumId),
  onAlbumStatsProgress: (callback) => {
    if (statsProgressListener) {
      ipcRenderer.removeListener('album:stats-progress', statsProgressListener)
    }
    statsProgressListener = (_event, payload: AlbumStatsProgress) => callback(payload)
    ipcRenderer.on('album:stats-progress', statsProgressListener)
  },
  startSimilarAnalysis: (albumId) => ipcRenderer.invoke('album:similar-start', albumId),
  pauseSimilarAnalysis: (albumId) => ipcRenderer.invoke('album:similar-pause', albumId),
  setSimilarForeground: (albumId, foreground) =>
    ipcRenderer.invoke('album:similar-foreground', albumId, foreground),
  setSimilarViewport: (albumId, start, end) =>
    ipcRenderer.invoke('album:similar-viewport', albumId, start, end),
  onSimilarSnapshot: (callback) => {
    if (similarSnapshotListener) {
      ipcRenderer.removeListener('album:similar-snapshot', similarSnapshotListener)
    }
    similarSnapshotListener = (_event, payload: SimilarSnapshot) => callback(payload)
    ipcRenderer.on('album:similar-snapshot', similarSnapshotListener)
  },
  getPhotoDetails: (photoId) => ipcRenderer.invoke('photo:details', photoId),
  listFavorites: () => ipcRenderer.invoke('favorites:list'),
  setFavorites: (photoIds, favorite) =>
    ipcRenderer.invoke('favorites:set', photoIds, favorite),
  startGearScan: (refresh) => ipcRenderer.invoke('gear:start', refresh),
  pauseGearScan: () => ipcRenderer.invoke('gear:pause'),
  onGearSnapshot: (callback) => {
    if (gearSnapshotListener) {
      ipcRenderer.removeListener('gear:snapshot', gearSnapshotListener)
    }
    gearSnapshotListener = (_event, payload: GearSnapshot) => callback(payload)
    ipcRenderer.on('gear:snapshot', gearSnapshotListener)
  },
  // 只保留一个订阅，避免热更新重挂载时重复监听
  onPhotosUpdated: (callback) => {
    if (photosUpdatedListener) {
      ipcRenderer.removeListener('album:photos-updated', photosUpdatedListener)
    }
    photosUpdatedListener = (_event, payload: PhotosUpdatedEvent) => callback(payload)
    ipcRenderer.on('album:photos-updated', photosUpdatedListener)
  }
}

contextBridge.exposeInMainWorld('api', api)
