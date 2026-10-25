import { contextBridge, ipcRenderer } from 'electron'
import type { AlbumApi } from '../shared/types'

const api: AlbumApi = {
  addAlbums: () => ipcRenderer.invoke('album:add'),
  listAlbums: () => ipcRenderer.invoke('album:list'),
  removeAlbum: (id) => ipcRenderer.invoke('album:remove', id),
  listPhotos: (albumId) => ipcRenderer.invoke('album:photos', albumId),
  getPhotoDetails: (photoId) => ipcRenderer.invoke('photo:details', photoId)
}

contextBridge.exposeInMainWorld('api', api)
