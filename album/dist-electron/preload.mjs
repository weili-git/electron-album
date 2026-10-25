"use strict";
const electron = require("electron");
const api = {
  addAlbums: () => electron.ipcRenderer.invoke("album:add"),
  listAlbums: () => electron.ipcRenderer.invoke("album:list"),
  removeAlbum: (id) => electron.ipcRenderer.invoke("album:remove", id),
  listPhotos: (albumId) => electron.ipcRenderer.invoke("album:photos", albumId)
};
electron.contextBridge.exposeInMainWorld("api", api);
