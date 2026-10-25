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
- 通过 `contextBridge` 暴露类型化的 `window.api`（见 `electron/preload.ts` 与 `shared/types.ts`）；保持 `sandbox: true`，不开启 `nodeIntegration`。
- 本地图片/缩略图通过自定义协议（计划 `thumb://`）提供，不通过 IPC 传输 base64，也不直接使用 `file://`。
- CSP 在 `album/index.html`，新增资源来源时同步更新（如 `img-src` 要包含 `thumb:`）。
- `vite.config.ts` 设置 `base: './'`，生产环境通过 `file://` 加载 `dist/index.html`。

## 产品流程（已确认）

1. 首页为相册库：点击"添加相册目录"选择一个或多个目录，按规范化路径去重。
2. 相册卡片显示封面：取创建时间最新的前 3 张缩略图，做成"扑克牌叠放"效果；不足 3 张时按实际张数叠放，空目录显示占位；照片总数显示在相册名称旁的计数徽标中。封面与照片共用 `thumb://` 缩略图管线。
3. 点击相册进入照片缩略图网格，图片懒加载；顶部显示相册名称、路径与张数。
4. 点击网格中的照片打开"观赏"窗口（`PhotoViewer.vue`）：磨砂玻璃遮罩 + 1920px 高清预览。点击照片（或按 `F`、点底部「详情」）让照片像卡片一样 3D 翻转，背面显示拍摄与图像信息；点击背面任意位置（或按 `F`）翻回正面。支持左/右方向键、按钮以及鼠标滚轮上下翻页（滚轮有约 320ms 节流；翻页自动回到正面；详情内容可滚动时优先滚动内容，滚到边界再翻页）、Esc（若在背面先翻回正面，再按一次关闭）、点击遮罩关闭；打开时锁定页面滚动并预加载相邻照片。
5. 相册记录包含独立的 `path` 与 `name`：`name` 默认取文件夹名，后续支持重命名（TODO）。
6. 相册库持久化于 `app.getPath('userData')/library.json`；目录被移动/删除时标记"目录不可用"。
7. 扫描范围为目录顶层，不递归；后续增加递归开关（TODO）。
8. 照片默认按文件创建时间倒序（`birthtimeMs`，取不到时回退 `mtimeMs`）；后续支持多种排序策略（TODO）。
9. 相册支持从库中移除（只移除记录，不删除磁盘文件）。

## 支持的图片格式

- 常见格式：jpg / jpeg / png / webp / gif / tif / tiff（sharp 处理）。
- 尼康 RAW：NEF。sharp 不能解码 NEF，使用 `extract-raw-preview` 提取内嵌 JPEG 预览，再交给 sharp 缩放。
- EXIF 缺失的测试图片允许存在，字段为空时忽略，不阻塞展示。

## 缩略图实现

- 自定义协议 `thumb://photo/<id>?w=<width>&v=<mtime>`：主进程按 id 从扫描登记表解析真实路径，不向渲染进程暴露路径，也不通过 IPC 传图片数据。
- 缓存位置 `app.getPath('userData')/thumbnails/`，缓存 key 包含路径、mtime、大小、宽度档位与版本号；URL 带 mtime 版本号绕过浏览器缓存。
- 宽度档位 160/320/480/640/960/1280/1920；网格用 320，封面用 480，观赏窗口用 1920。sharp 并发限制为 4，同一 key 的并发生成会去重。
- `Photo` 同时返回 `thumbUrl`（网格）与 `viewUrl`（观赏窗口）；两者都走同一个 `thumb://` 协议，只是宽度参数不同。
- `img-src` CSP 已包含 `thumb:`。

## 照片详情（观赏窗口背面）

- 主进程模块 `electron/photoInfo.ts`，通过 `photo:details` IPC 按需读取，**不在扫描相册时预读 EXIF**。
- 使用 `exifr` 解析标准 EXIF：相机、镜头、焦距/35mm 等效、光圈、快门、ISO、曝光补偿、拍摄时间；只 `pick` 需要的字段。
- 尺寸优先取 EXIF 的 `ExifImageWidth/Height`，缺失时回退 `sharp.metadata()`；NEF 跳过 sharp。按 `Orientation` 5–8 交换宽高，与自动旋转后的预览保持一致。
- EXIF 时间是相机本地墙上时间，按年月日时分秒直接构造 `Date`，不做时区平移。
- 详情按 `path|mtime|size` 做 LRU 缓存（上限 300），文件变化后自动失效；渲染进程在一次观赏会话内也会缓存。
- 无 EXIF 的图片只显示图像信息并提示"没有拍摄信息"；读取失败不阻塞看图。
- `exifr` 为纯 JS，直接打包进主进程；sharp / extract-raw-preview 仍为 external。

## TODO

- [x] MVP：相册库（添加/移除/持久化）+ 三张叠放封面 + `thumb://` 缩略图协议 + 照片网格
- [x] 照片观赏窗口：磨砂玻璃遮罩、1920px 高清预览、键盘/按钮翻页、相邻预加载
- [x] 照片翻转详情：3D 卡片翻转 + EXIF 按需读取（相机/镜头/焦距/光圈/快门/ISO/拍摄时间）+ 尺寸/格式/大小
- [ ] 用真实尼康 NEF 样张验证 `extract-raw-preview` 的预览尺寸、方向与缓存行为
- [ ] 扫描性能优化：目前每次列出相册都会 stat 全部文件，后续改为缓存扫描结果并在后台刷新
- [ ] 相册重命名（`name` 与 `path` 已分离，需补 IPC 与 UI）
- [ ] 多种照片排序策略（拍摄时间、文件名、大小等），默认创建时间倒序
- [ ] 递归扫描开关
- [ ] 相似图片归类（进入相册后的视图，暂不实现）：先用 pHash/dHash + Hamming 距离 + 并查集聚类；效果不足再考虑 CLIP embedding
- [ ] EXIF 统计（后期）：焦距、光圈、快门、ISO、拍摄时间；缺失值为 null 并在统计时跳过；数据量增大后引入 better-sqlite3 索引
- [ ] NEF 详情验证：当前用 exifr 读标准 EXIF；如果后续需要尼康 maker notes（如镜头编号、快门次数），再评估 exiftool-vendored
- [ ] 目录监听（chokidar）与缩略图缓存失效策略
- [ ] 打包验证：sharp 原生模块的 externalize / asarUnpack 配置
- [ ] 视频/HEIC 等更多格式支持（按需）；观赏窗口目前只加载 1920px 档位，超大图/缩放查看可后续增强
