import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AlbumApi, AlbumStatsProgress, PhotosUpdatedEvent } from '../shared/types'

let photosUpdatedListener: ((event: IpcRendererEvent, payload: PhotosUpdatedEvent) => void) | null = null
let statsProgressListener:
  | ((event: IpcRendererEvent, payload: AlbumStatsProgress) => void)
  | null = null

const api: AlbumApi = {
  addAlbums: () => ipcRenderer.invoke('album:add'),
  listAlbums: () => ipcRenderer.invoke('album:list'),
  removeAlbum: (id) => ipcRenderer.invoke('album:remove', id),
  listPhotos: (albumId) => ipcRenderer.invoke('album:photos', albumId),
  setThumbnailScope: (albumPath) => ipcRenderer.invoke('thumb:set-scope', albumPath),
  getAlbumStats: (albumId) => ipcRenderer.invoke('album:stats', albumId),
  onAlbumStatsProgress: (callback) => {
    if (statsProgressListener) {
      ipcRenderer.removeListener('album:stats-progress', statsProgressListener)
    }
    statsProgressListener = (_event, payload: AlbumStatsProgress) => callback(payload)
    ipcRenderer.on('album:stats-progress', statsProgressListener)
  },
  getPhotoDetails: (photoId) => ipcRenderer.invoke('photo:details', photoId),
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
