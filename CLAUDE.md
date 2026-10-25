# 本地相册管理软件

Electron + Vue 3 + TypeScript 本地相册应用。仓库根目录为 `E:\album`，应用代码在 `album/`。

## 常用命令

```bash
cd album
npm run dev              # Vite + Electron 开发模式
npx vue-tsc --noEmit     # 类型检查
npx vite build           # 仅构建产物（dist/ 与 dist-electron/）
npm run build            # 类型检查 + 构建 + electron-builder 打包
```

## 架构约定

- 主进程：`album/electron/main.ts`；preload：`album/electron/preload.ts`。
- 项目是 ESM（`"type": "module"`），preload 产物为 `dist-electron/preload.mjs`，主进程引用时注意扩展名。
- 渲染进程：Vue 3 SFC，位于 `album/src/`。
- 通过 `contextBridge` 暴露 `window.ipcRenderer`；保持 `sandbox: true`，不开启 `nodeIntegration`。
- 本地图片/缩略图通过自定义协议（计划 `thumb://`）提供，不通过 IPC 传输 base64，也不直接使用 `file://`。
- CSP 在 `album/index.html`，新增资源来源时同步更新（如 `img-src` 要包含 `thumb:`）。
- `vite.config.ts` 设置 `base: './'`，生产环境通过 `file://` 加载 `dist/index.html`。

## 产品流程（已确认）

1. 首页为相册库：点击"添加相册目录"选择一个或多个目录，按规范化路径去重。
2. 相册卡片显示封面：取创建时间最新的前 3 张缩略图，做成"扑克牌叠放"效果；不足 3 张时按实际张数叠放，空目录显示占位；卡片右上角显示照片总数。封面与照片共用 `thumb://` 缩略图管线。
3. 点击相册进入照片缩略图网格，图片懒加载；顶部显示相册名称、路径与张数。
4. 相册记录包含独立的 `path` 与 `name`：`name` 默认取文件夹名，后续支持重命名（TODO）。
5. 相册库持久化于 `app.getPath('userData')/library.json`；目录被移动/删除时标记"目录不可用"。
6. 扫描范围为目录顶层，不递归；后续增加递归开关（TODO）。
7. 照片默认按文件创建时间倒序（`birthtimeMs`，取不到时回退 `mtimeMs`）；后续支持多种排序策略（TODO）。
8. 相册支持从库中移除（只移除记录，不删除磁盘文件）。

## 支持的图片格式

- 常见格式：jpg / jpeg / png / webp / gif / tif / tiff（sharp 处理）。
- 尼康 RAW：NEF。sharp 不能解码 NEF，使用 `extract-raw-preview` 提取内嵌 JPEG 预览，再交给 sharp 缩放。
- EXIF 缺失的测试图片允许存在，字段为空时忽略，不阻塞展示。

## 缩略图实现

- 自定义协议 `thumb://photo/<id>?w=<width>&v=<mtime>`：主进程按 id 从扫描登记表解析真实路径，不向渲染进程暴露路径，也不通过 IPC 传图片数据。
- 缓存位置 `app.getPath('userData')/thumbnails/`，缓存 key 包含路径、mtime、大小、宽度档位与版本号；URL 带 mtime 版本号绕过浏览器缓存。
- 宽度档位 160/320/480/640/960；sharp 并发限制为 4，同一 key 的并发生成会去重。
- `img-src` CSP 已包含 `thumb:`。

## TODO

- [x] MVP：相册库（添加/移除/持久化）+ 三张叠放封面 + `thumb://` 缩略图协议 + 照片网格
- [ ] 用真实尼康 NEF 样张验证 `extract-raw-preview` 的预览尺寸、方向与缓存行为
- [ ] 扫描性能优化：目前每次列出相册都会 stat 全部文件，后续改为缓存扫描结果并在后台刷新
- [ ] 相册重命名（`name` 与 `path` 已分离，需补 IPC 与 UI）
- [ ] 多种照片排序策略（拍摄时间、文件名、大小等），默认创建时间倒序
- [ ] 递归扫描开关
- [ ] 相似图片归类（进入相册后的视图，暂不实现）：先用 pHash/dHash + Hamming 距离 + 并查集聚类；效果不足再考虑 CLIP embedding
- [ ] EXIF 统计（后期）：焦距、光圈、快门、ISO、拍摄时间；缺失值为 null 并在统计时跳过；数据量增大后引入 better-sqlite3 索引
- [ ] NEF EXIF 读取选型：exifr（轻量、纯 JS）对比 exiftool-vendored（Nikon maker notes 更完整），用测试图片验证后决定
- [ ] 目录监听（chokidar）与缩略图缓存失效策略
- [ ] 打包验证：sharp 原生模块的 externalize / asarUnpack 配置
- [ ] 大图预览与视频/HEIC 等更多格式支持（按需）
