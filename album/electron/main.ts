import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { addAlbums, getAlbums, listPhotos, loadLibrary, removeAlbum } from './library'
import { installThumbProtocol, registerThumbScheme } from './thumbnails'

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
    win.webContents.openDevTools()
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
}

app.whenReady().then(async () => {
  await loadLibrary()
  installThumbProtocol()
  registerIpc()
  createWindow()
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
