import { app, BrowserWindow, ipcMain, dialog, Menu } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  addAlbums,
  getAlbumStats,
  getAlbums,
  listPhotos,
  loadLibrary,
  pauseSimilarAnalysis,
  removeAlbum,
  setPhotosUpdatedHandler,
  setSimilarForeground,
  setSimilarViewport,
  startSimilarAnalysis
} from './library'
import { flushExifCacheSync } from './exifStats'
import { readPhotoDetails } from './photoInfo'
import { getPhotoFile } from './photos'
import { flushScanCacheSync, loadScanCache } from './scanCache'
import { flushSimilarCacheSync } from './similarity'
import {
  installThumbProtocol,
  registerThumbScheme,
  setThumbnailScope,
  setThumbnailViewport
} from './thumbnails'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let win: BrowserWindow | null = null

// 自定义协议必须在 app ready 之前注册
registerThumbScheme()

const createWindow = () => {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: '本地相册',
    backgroundColor: '#141416',
    autoHideMenuBar: true,
    webPreferences: {
      // package.json 中 "type": "module"，preload 会被编译为 preload.mjs
      preload: path.join(__dirname, 'preload.mjs'),
      sandbox: true
    }
  })

  win.on('closed', () => {
    win = null
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    // 开发环境：vite-plugin-electron 注入的开发服务器地址
    win.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    // 生产环境：vite build 输出到 dist/index.html
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('album:add', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return addAlbums(result.filePaths)
  })

  ipcMain.handle('album:list', () => getAlbums())

  ipcMain.handle('album:remove', (_event, albumId: unknown) => {
    if (typeof albumId !== 'string') throw new Error('无效的相册 id')
    return removeAlbum(albumId)
  })

  ipcMain.handle('album:photos', (_event, albumId: unknown) => {
    if (typeof albumId !== 'string') throw new Error('无效的相册 id')
    return listPhotos(albumId)
  })

  ipcMain.handle('photo:details', (_event, photoId: unknown) => {
    if (typeof photoId !== 'string') throw new Error('无效的照片 id')
    const file = getPhotoFile(photoId)
    if (!file) return null
    return readPhotoDetails(file)
  })

  // 渲染进程切换视图时通知主进程，取消上一视图排队中的缩略图任务
  ipcMain.handle('thumb:set-scope', (_event, albumPath: unknown) => {
    if (albumPath !== null && typeof albumPath !== 'string') {
      throw new Error('无效的相册路径')
    }
    setThumbnailScope(albumPath)
  })

  // 拖动滚动条后，屏幕内照片的缩略图优先于沿途跳过的行
  ipcMain.handle('thumb:set-viewport', (_event, photoIds: unknown) => {
    if (!Array.isArray(photoIds) || photoIds.some((id) => typeof id !== 'string')) {
      throw new Error('无效的可见照片列表')
    }
    setThumbnailViewport(photoIds)
  })

  ipcMain.handle('album:stats', (event, albumId: unknown) => {
    if (typeof albumId !== 'string') throw new Error('无效的相册 id')
    const sender = event.sender
    return getAlbumStats(albumId, (processed, total) => {
      if (!sender.isDestroyed()) {
        sender.send('album:stats-progress', { albumId, processed, total })
      }
    })
  })

  ipcMain.handle('album:similar-start', (event, albumId: unknown) => {
    if (typeof albumId !== 'string') throw new Error('无效的相册 id')
    const sender = event.sender
    return startSimilarAnalysis(albumId, (snapshot) => {
      if (!sender.isDestroyed()) {
        sender.send('album:similar-snapshot', snapshot)
      }
    })
  })

  ipcMain.handle('album:similar-pause', (_event, albumId: unknown) => {
    if (typeof albumId !== 'string') throw new Error('无效的相册 id')
    return pauseSimilarAnalysis(albumId)
  })

  ipcMain.handle(
    'album:similar-foreground',
    (_event, albumId: unknown, foreground: unknown) => {
      if (typeof albumId !== 'string') throw new Error('无效的相册 id')
      if (typeof foreground !== 'boolean') throw new Error('无效的前台状态')
      setSimilarForeground(albumId, foreground)
    }
  )

  ipcMain.handle(
    'album:similar-viewport',
    (_event, albumId: unknown, start: unknown, end: unknown) => {
      if (typeof albumId !== 'string') throw new Error('无效的相册 id')
      if (typeof start !== 'number' || typeof end !== 'number') {
        throw new Error('无效的视口范围')
      }
      setSimilarViewport(albumId, start, end)
    }
  )
}

app.whenReady().then(async () => {
  // 移除 Electron 默认菜单（File/Edit/View/…），界面更简洁
  Menu.setApplicationMenu(null)
  await Promise.all([loadLibrary(), loadScanCache()])
  installThumbProtocol()
  registerIpc()
  createWindow()

  // 后台重扫发现变化时推送给渲染进程
  setPhotosUpdatedHandler((albumId, photos) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('album:photos-updated', { albumId, photos })
    }
  })
})

app.on('before-quit', () => {
  flushScanCacheSync()
  flushExifCacheSync()
  flushSimilarCacheSync()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
