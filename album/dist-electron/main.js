import { ipcMain, dialog, app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __filename$1 = fileURLToPath(import.meta.url);
const __dirname$1 = path.dirname(__filename$1);
let win = null;
const createWindow = () => {
  win = new BrowserWindow({
    width: 1e3,
    height: 700,
    title: "本地相册",
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
ipcMain.handle("open-select-folder", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"]
  });
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0];
});
app.whenReady().then(createWindow);
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
