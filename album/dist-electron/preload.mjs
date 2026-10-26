"use strict";
const electron = require("electron");
let photosUpdatedListener = null;
let statsProgressListener = null;
let similarSnapshotListener = null;
const api = {
  addAlbums: () => electron.ipcRenderer.invoke("album:add"),
  listAlbums: () => electron.ipcRenderer.invoke("album:list"),
  removeAlbum: (id) => electron.ipcRenderer.invoke("album:remove", id),
  listPhotos: (albumId) => electron.ipcRenderer.invoke("album:photos", albumId),
  setThumbnailScope: (albumPath) => electron.ipcRenderer.invoke("thumb:set-scope", albumPath),
  getAlbumStats: (albumId) => electron.ipcRenderer.invoke("album:stats", albumId),
  onAlbumStatsProgress: (callback) => {
    if (statsProgressListener) {
      electron.ipcRenderer.removeListener("album:stats-progress", statsProgressListener);
    }
    statsProgressListener = (_event, payload) => callback(payload);
    electron.ipcRenderer.on("album:stats-progress", statsProgressListener);
  },
  startSimilarAnalysis: (albumId) => electron.ipcRenderer.invoke("album:similar-start", albumId),
  pauseSimilarAnalysis: (albumId) => electron.ipcRenderer.invoke("album:similar-pause", albumId),
  setSimilarViewport: (albumId, start, end) => electron.ipcRenderer.invoke("album:similar-viewport", albumId, start, end),
  onSimilarSnapshot: (callback) => {
    if (similarSnapshotListener) {
      electron.ipcRenderer.removeListener("album:similar-snapshot", similarSnapshotListener);
    }
    similarSnapshotListener = (_event, payload) => callback(payload);
    electron.ipcRenderer.on("album:similar-snapshot", similarSnapshotListener);
  },
  getPhotoDetails: (photoId) => electron.ipcRenderer.invoke("photo:details", photoId),
  // 只保留一个订阅，避免热更新重挂载时重复监听
  onPhotosUpdated: (callback) => {
    if (photosUpdatedListener) {
      electron.ipcRenderer.removeListener("album:photos-updated", photosUpdatedListener);
    }
    photosUpdatedListener = (_event, payload) => callback(payload);
    electron.ipcRenderer.on("album:photos-updated", photosUpdatedListener);
  }
};
electron.contextBridge.exposeInMainWorld("api", api);
