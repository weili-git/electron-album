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
5. 观赏窗口内右键、点底部「放大」或按 `Z` 进入细看层（`PhotoInspect.vue`）：默认 1x 适应窗口，加载原图，支持缩放与拖拽；与观赏窗口的翻页、翻转逻辑隔离，Esc 返回观赏窗口。
6. 相册记录包含独立的 `path` 与 `name`：`name` 默认取文件夹名，后续支持重命名（TODO）。
7. 相册库持久化于 `app.getPath('userData')/library.json`；目录被移动/删除时标记"目录不可用"。
8. 扫描范围为目录顶层，不递归；后续增加递归开关（TODO）。
9. 照片默认按文件创建时间倒序（`birthtimeMs`，取不到时回退 `mtimeMs`）；后续支持多种排序策略（TODO）。
10. 相册支持从库中移除（只移除记录，不删除磁盘文件）。
11. 相册顶部「统计」按钮打开 `AlbumStatsPanel.vue`：按需读取 EXIF，统计焦距、光圈、快门、ISO、拍摄月份与时段，并显示拍摄时间范围；首次读取显示进度，之后命中缓存。

## 支持的图片格式

- 常见格式：jpg / jpeg / png / webp / gif / tif / tiff（sharp 处理）。
- 尼康 RAW：NEF。sharp 不能解码 NEF，使用 `extract-raw-preview` 提取内嵌 JPEG 预览，再交给 sharp 缩放。
- EXIF 缺失的测试图片允许存在，字段为空时忽略，不阻塞展示。

## 扫描缓存与增量刷新

- 扫描结果持久化于 `app.getPath('userData')/scan-cache.json`（`electron/scanCache.ts`）：记录目录 mtime、照片名、创建时间、mtime、大小；照片真实路径由“相册目录 + 文件名”还原，不重复存储。
- 打开相册时先返回缓存，界面立即渲染；`revalidateAlbum` 在后台检查目录签名并重扫，发现变化时通过 `album:photos-updated` IPC 推送给渲染进程。缓存 5 分钟内且目录 mtime 未变则跳过重扫。
- 目录 mtime 只能感知增删/改名，感知不到文件内容原地修改；后者依赖 5 分钟 TTL 的后台重扫兜底。缩略图 URL 的 `v` 参数会随重扫后的 mtime 更新。
- 相册库首页用目录签名判断：签名未变直接读缓存，只有 mtime 变化或缓存缺失才同步重扫该相册。首页只计算“张数 + 前 3 张封面”，不还原、不登记整本相册的照片，因此 `getAlbums` 开销与相册数量相关，不再随照片总数线性增长；整本还原发生在打开相册时。
- 暂不使用 better-sqlite3：当前 Electron 30 内置 Node 20，而安装的 better-sqlite3 v13 要求 Node 22+，加载会崩溃；后续升级 Electron 后再考虑迁移 SQLite。

## 缩略图实现

- 自定义协议 `thumb://photo/<id>?w=<width>&v=<mtime>&p=<view|grid|cover>`：主进程按 id 从扫描登记表解析真实路径，不向渲染进程暴露路径，也不通过 IPC 传图片数据。`p` 只影响生成优先级；没有 `p` 时按宽度回退。
- 缓存位置 `app.getPath('userData')/thumbnails/`，缓存 key 包含路径、mtime、大小、宽度档位与版本号；URL 带 mtime 版本号绕过浏览器缓存。
- 宽度档位 160/320/480/640/960/1280/1920；网格用 320，封面用 480，观赏窗口用 1920。并发生成上限为 `max(4, min(8, CPU 并行度))`；队列按 `view > grid > cover` 三级 FIFO 取任务，观赏窗口不会被网格或封面阻塞。同一 key 的并发生成会去重。`sharp.concurrency(1)` 避免与外部并发叠加造成 CPU 超订。
- 渲染进程切换视图时通过 `thumb:set-scope` IPC 告知主进程当前相册目录（首页为 `null`）：排队中的旧视图任务会被取消（返回 404），避免浏览大相册或相册库后，遗留的缩略图任务拖慢随后打开的小相册。已在生成中的任务（最多并发数个）无法中断，但会在一个任务时长内结束。
- 照片网格使用固定方格虚拟滚动：按容器宽度计算列数与格子尺寸，只渲染可视区上下各 3 行；`.photo` 绝对定位，`.photo-grid` 高度按总行数内联设置。列宽/间距由 CSS 变量 `--photo-min-cell` / `--photo-gap` 提供（680px 媒体查询切换），PhotoGrid 读取后计算，断点只维护一处。
- `Photo` 同时返回 `thumbUrl`（网格，`p=grid`）、`viewUrl`（观赏窗口，`p=view`）与 `originalUrl`（细看层，`original=1`）；封面 URL 用 `p=cover`。四者都走同一个 `thumb://` 协议，只是宽度、优先级或原图参数不同。
- `img-src` CSP 已包含 `thumb:`。

## 细看层（原图放大）

- 入口：观赏窗口右键、底部「放大」或 `Z`。`PhotoInspect.vue` 通过 `Teleport` 挂到 `body`，与观赏窗口/相册翻页完全隔离——细看层内不响应左右翻页，观赏窗口在细看层打开期间也跳过滚轮与键盘处理。
- 图片走原图管线：`Photo.originalUrl` 指向 `thumb://photo/<id>?original=1&v=<mtime>`。JPG/PNG/WebP/GIF 由主进程用 `net.fetch(file://…)` 流式返回原文件；NEF 用 `extract-raw-preview` 取最大的可解码内嵌预览；TIFF 用 sharp 按原始像素转 PNG。响应带 immutable 长缓存，`v` 随 mtime 变化后自动换 URL。
- 打开时先显示观赏窗口已缓存的 1920 预览，同时后台预加载原图，加载完成无缝替换（名称旁标注“原图”）；原图失败时退回预览并提示。
- 默认 1x 适应窗口（`scale = 1`，图片由 CSS 限制在框内）。Ctrl/⌘ + 滚轮（含触控板捏合）以光标为锚点缩放，范围 1–16x；普通滚轮/Shift+滚轮平移；放大后按住拖动平移（4px 阈值，拖拽结束后的补发 click 会被忽略）；单击图片在适应窗口与 2x 之间切换（双击只响应第一下）；点击图片外的空白区域返回观赏窗口，顶部/底部工具栏不触发关闭；底部提供 − / 百分比 / + / 1:1。
- 图片缩放使用 2D `translate() scale()`，并移除 `will-change`：`translate3d`/合成层会按适应窗口的尺寸栅格化后再放大，高倍缩放明显发虚。1:1 按 `naturalWidth / (offsetWidth × devicePixelRatio)` 对齐物理像素，高 DPI 屏不会额外放大；若在预览图阶段点了 1:1，原图加载完成后会自动重新对齐。
- 键盘：Esc 关闭细看层并返回观赏窗口，`+`/`-` 缩放，`0` 复位，方向键平移；细看层在捕获阶段 `stopPropagation`，避免同一次按键继续触发观赏窗口逻辑。
- 页面滚动锁由 `useScrollLock.ts` 计数管理：观赏窗口与细看层同时打开时，只有最后一个关闭才恢复 `body.overflow`。
- 层级：观赏窗口 50、EXIF 统计 55、细看层 60；预留编辑层 70。后续图片编辑作为独立层接入，复用原图管线与隔离/滚动锁机制。

## 照片详情（观赏窗口背面）

- 主进程模块 `electron/photoInfo.ts`，通过 `photo:details` IPC 按需读取，**不在扫描相册时预读 EXIF**。
- 使用 `exifr` 解析标准 EXIF：相机、镜头、焦距/35mm 等效、光圈、快门、ISO、曝光补偿、拍摄时间；只 `pick` 需要的字段。
- 尺寸优先取 EXIF 的 `ExifImageWidth/Height`，缺失时回退 `sharp.metadata()`；NEF 跳过 sharp。按 `Orientation` 5–8 交换宽高，与自动旋转后的预览保持一致。
- EXIF 时间是相机本地墙上时间，按年月日时分秒直接构造 `Date`，不做时区平移。
- 详情按 `path|mtime|size` 做 LRU 缓存（上限 300），文件变化后自动失效；渲染进程在一次观赏会话内也会缓存。
- 无 EXIF 的图片只显示图像信息并提示"没有拍摄信息"；读取失败不阻塞看图。
- `exifr` 为纯 JS，直接打包进主进程；sharp / extract-raw-preview 仍为 external。

## EXIF 统计（相册视图）

- 主进程模块 `electron/exifStats.ts`，UI 为 `src/components/AlbumStatsPanel.vue`，由相册顶部「统计」按钮打开；`album:stats` IPC 按需触发，**不在扫描或打开相册时预读**。
- `exifr` 只 `pick` 统计需要的字段（`FocalLength`、`FocalLengthIn35mmFormat`、`FNumber`、`ExposureTime`、`ISO`/`ISOSpeedRatings`、`DateTimeOriginal`/`CreateDate`），并关闭 `translateValues` / `reviveValues`，统一由 `electron/exif.ts` 的 `toNumber`、`parseExifDate` 解析。
- 逐张读取并发 4；单张解析失败按“没有拍摄信息”处理，不阻塞整本相册。进度通过 `album:stats-progress` 推送（150ms 节流），渲染进程按 `albumId` 过滤。
- 同一相册的并发统计请求在 `library.ts` 中合并为同一个任务，多个监听者共享进度；相册被移除时同时删除 `statsJobs` 条目与缓存文件。
- 缓存位置 `app.getPath('userData')/exif-cache/<albumId>.json`，按相册分文件，避免启动时加载整个库。entry 以照片 id（规范化路径的 sha1）为 key，记录 `mtimeMs` / `size` 用于失效；保存时裁掉已不在相册中的照片，采用临时文件 + rename 原子写入，退出时 `before-quit` 同步落盘。
- 汇总规则：焦距优先取 35mm 等效，缺失时用实际焦距，按 ≤20 / 21–35 / 36–50 / 51–85 / 86–135 / 136–200 / 201–400 / >400 mm 分档；光圈按 0.1 档取值；快门按 1/3 档左右分档；ISO 取整；拍摄时间按相机本地墙上时间归到 `YYYY-MM` 与 `HH:00`。缺失值不参与统计，空档位不返回。
- `withExif` 表示至少含有一个统计字段的照片数；`firstTakenAt` / `lastTakenAt` 给出拍摄时间范围。
- UI 使用纯 CSS 横向条形图，不引入图表库；首次统计会提示“逐张读取、完成后缓存”，无 EXIF 时显示空状态而不报错。

## TODO

- [x] MVP：相册库（添加/移除/持久化）+ 三张叠放封面 + `thumb://` 缩略图协议 + 照片网格
- [x] 照片观赏窗口：磨砂玻璃遮罩、1920px 高清预览、键盘/按钮翻页、相邻预加载
- [x] 照片翻转详情：3D 卡片翻转 + EXIF 按需读取（相机/镜头/焦距/光圈/快门/ISO/拍摄时间）+ 尺寸/格式/大小
- [x] 细看层：原图管线（JPG/PNG/WebP/GIF 直读、NEF 内嵌预览、TIFF 转 PNG）+ 1x 适应窗口 + Ctrl/⌘ 滚轮缩放 + 拖拽平移 + 1:1
- [ ] 用真实尼康 NEF 样张验证 `extract-raw-preview` 的预览尺寸、方向与缓存行为
- [x] 扫描性能优化：`scan-cache.json` 持久化 + 目录 mtime 失效 + 先显示缓存后台刷新；缩略图并发/优先级调优
- [x] 网格虚拟滚动：固定方格行窗口化（只渲染可视区 ±3 行），5000 张相册实测 DOM 从 5000 降到约 24–36 个格子
- [ ] 缩略图缓存容量上限（LRU）与后台预取首屏缩略图
- [ ] 相册重命名（`name` 与 `path` 已分离，需补 IPC 与 UI）
- [ ] 多种照片排序策略（拍摄时间、文件名、大小等），默认创建时间倒序
- [ ] 递归扫描开关
- [ ] 相似图片归类（进入相册后的视图，暂不实现）：先用 pHash/dHash + Hamming 距离 + 并查集聚类；效果不足再考虑 CLIP embedding
- [x] EXIF 统计 v1：焦距、光圈、快门、ISO、拍摄月份/时段、拍摄时间范围；按相册缓存 + 进度推送 + 纯 CSS 条形图
- [ ] EXIF 统计增强（数据量增大后）：better-sqlite3 索引、跨相册汇总、按时间/器材筛选
- [ ] NEF 详情验证：当前用 exifr 读标准 EXIF；如果后续需要尼康 maker notes（如镜头编号、快门次数），再评估 exiftool-vendored
- [ ] 目录监听（chokidar）与缩略图缓存失效策略
- [ ] 编辑层（独立于观赏窗口与细看层）：复用 `originalUrl`、层级 70 与隔离/滚动锁机制
- [ ] 打包验证：sharp 原生模块的 externalize / asarUnpack 配置
- [ ] 视频/HEIC 等更多格式支持（按需）；观赏窗口保持 1920px 档位，超大图与像素级查看交给细看层
