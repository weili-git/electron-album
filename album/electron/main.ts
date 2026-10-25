import { app, BrowserWindow, ipcMain, dialog } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let win: BrowserWindow | null = null

const createWindow = () => {
  win = new BrowserWindow({
    width: 1000,
    height: 700,
    title: '本地相册',
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

ipcMain.handle('open-select-folder', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  })
  if (result.canceled) {
    return null
  }
  return result.filePaths[0]
})

app.whenReady().then(createWindow)

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
