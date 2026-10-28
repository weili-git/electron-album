/** 相册库中的相册（主进程返回给渲染进程的完整形态） */
export interface Album {
  id: string
  /** 文件夹的真实路径 */
  path: string
  /** 相册名称，默认取文件夹名，后续可重命名 */
  name: string
  addedAt: number
  photoCount: number
  /** 封面缩略图 URL（最多 3 张，按创建时间倒序） */
  coverThumbs: string[]
  /** 目录不存在或不可访问 */
  missing: boolean
}

/** 相册中的一张照片 */
export interface Photo {
  id: string
  name: string
  /** 文件创建时间（取不到时用修改时间），用于默认排序 */
  createdAt: number
  /** 网格缩略图（宽 320） */
  thumbUrl: string
  /** 观赏窗口使用的高清预览（宽 1920，按需生成并缓存） */
  viewUrl: string
  /** 细看层使用的原图（或 RAW 内嵌预览），按原始像素提供 */
  originalUrl: string
}

/** 后台重新扫描发现照片变化时，主进程推送给渲染进程 */
export interface PhotosUpdatedEvent {
  albumId: string
  photos: Photo[]
}

export interface AddAlbumsResult {
  albums: Album[]
  /** 本次实际新增的目录数量 */
  added: number
  /** 因重复而未添加的目录数量 */
  skipped: number
}

/** 观赏窗口翻转后展示的照片详情 */
export interface PhotoDetails {
  /** 原图像素尺寸（已按 EXIF 方向校正） */
  width: number | null
  height: number | null
  /** 展示用格式名，如 JPEG / PNG / TIFF / NEF */
  format: string
  sizeBytes: number
  /** 文件修改时间 */
  modifiedAt: number
  /** 拍摄时间：相机本地墙上时间的时间戳 */
  takenAt: number | null
  /** 相机型号（Make + Model 去重） */
  camera: string | null
  lens: string | null
  focalLength: number | null
  /** 35mm 等效焦距 */
  focalLength35: number | null
  aperture: number | null
  /** 快门时间，单位秒 */
  shutterSeconds: number | null
  iso: number | null
  /** 曝光补偿，单位 EV */
  exposureBias: number | null
}

/** EXIF 统计中的一个分布项 */
export interface StatsBucket {
  label: string
  count: number
}

/** 单个相册的 EXIF 统计结果；缺失字段对应的分布为空数组 */
export interface AlbumStats {
  photoCount: number
  /** 至少有一项拍摄信息（时间/焦距/光圈/快门/ISO）的照片数 */
  withExif: number
  /** 拍摄时间范围，取自 EXIF 的相机本地时间 */
  firstTakenAt: number | null
  lastTakenAt: number | null
  /** 焦距分布，优先使用 35mm 等效焦距 */
  focalLengths: StatsBucket[]
  apertures: StatsBucket[]
  shutterSpeeds: StatsBucket[]
  isos: StatsBucket[]
  /** 按 EXIF 拍摄月份（YYYY-MM）分布 */
  months: StatsBucket[]
  /** 按 EXIF 拍摄小时（0–23）分布 */
  hours: StatsBucket[]
}

/** EXIF 统计进度；主进程逐张读取时推送 */
export interface AlbumStatsProgress {
  albumId: string
  processed: number
  total: number
}

/** 拍摄设备库：单个相册的参考设备结论 */
export interface GearAlbumInfo {
  albumId: string
  /** 相册照片总数，设备张数为各相册张数之和（按相册归属估算） */
  photoCount: number
  /** 样本中的主机身 key；未识别时为 null */
  cameraKey: string | null
  cameraName: string | null
  /** 样本中的机身分布，label 为展示名 */
  cameras: StatsBucket[]
  /** 样本里出现多于一台机身 */
  mixed: boolean
  /** 实际读取的参考照片数 */
  sampleCount: number
  /** 其中带机身信息的数量 */
  sampleWithCamera: number
  /** 合并参考样本与相似分析已读照片后最常见的镜头 */
  referenceLens: string | null
  /** 镜头信息覆盖的照片数（参考样本 + 相似分析已读取），不是整本相册 */
  lensPhotoCount: number
  /** 样本中最新一张的文件创建时间，用于选设备封面 */
  latestSampleAt: number | null
}

/** 拍摄设备库中的一台机身 */
export interface GearDevice {
  key: string
  name: string
  /** 归属该机身的相册 id */
  albumIds: string[]
  albumCount: number
  /** 归属相册张数之和，按相册归属估算 */
  photoCount: number
  /** 代表性相册 id，封面取它的 coverThumbs[0] */
  coverAlbumId: string | null
  /** 按已读取照片数排序的镜头，最多 12 支（UI 默认展示前 2 支，其余折叠） */
  referenceLenses: StatsBucket[]
  /** 镜头信息覆盖的照片数，随相册浏览逐步增加 */
  lensPhotoCount: number
  /** 该设备下参考样本总数 */
  sampleCount: number
  /** 其中有设备信息的样本数 */
  sampleWithCamera: number
  /** 含混合样本的相册数 */
  mixedAlbumCount: number
}

/** 设备库扫描快照；分析过程中会多次推送 */
export interface GearSnapshot {
  /** 已检查相册的参考结论（不含空相册） */
  albums: GearAlbumInfo[]
  cameras: GearDevice[]
  /** 参考样本没有机身信息的相册 */
  unknownAlbumIds: string[]
  /** 目录不可用而跳过的相册 */
  missingAlbumIds: string[]
  checkedAlbums: number
  totalAlbums: number
  scanning: boolean
  error: string | null
}

/** 一组视觉上相似的照片（至少两张） */
export interface SimilarGroup {
  /** 组内照片 id，按相册默认顺序（创建时间倒序）排列 */
  photoIds: string[]
}

/**
 * 相似照片分析的渐进快照；分析过程中会多次推送，组只会增长。
 * 整本相册恰好全部分析完时会做一次组级合并，完成快照的组数或成员可能发生变化。
 */
export interface SimilarSnapshot {
  albumId: string
  groups: SimilarGroup[]
  /** 整本相册中已处理的照片数（含缓存命中与解码失败） */
  processed: number
  total: number
  /** 当前浏览窗口内已无待办 */
  complete: boolean
  /** 整本相册的所有照片都已处理 */
  albumComplete: boolean
  /** 当前浏览窗口内的待分析张数 */
  windowPending: number
  /** 当前浏览窗口的总张数 */
  windowTotal: number
  /** 分析出错时的提示，正常为 null */
  error: string | null
}

/** preload 暴露给渲染进程的 API */
export interface AlbumApi {
  /** 打开选择目录对话框；取消时返回 null */
  addAlbums(): Promise<AddAlbumsResult | null>
  listAlbums(): Promise<Album[]>
  removeAlbum(id: string): Promise<Album[]>
  listPhotos(albumId: string): Promise<Photo[]>
  /** 告知主进程当前可见的相册目录（null 表示相册库首页），用于取消旧视图的缩略图任务 */
  setThumbnailScope(albumPath: string | null): Promise<void>
  /** 告知主进程当前屏幕内可见的照片 id，缩略图队列优先处理这些照片 */
  setThumbnailViewport(photoIds: string[]): Promise<void>
  /** 读取相册的 EXIF 统计；首次读取逐张解析，之后使用缓存 */
  getAlbumStats(albumId: string): Promise<AlbumStats | null>
  /** 订阅 EXIF 统计进度；同一时间只保留一个订阅 */
  onAlbumStatsProgress(callback: (event: AlbumStatsProgress) => void): void
  /** 开始或继续当前窗口的相似分析；结果通过 onSimilarSnapshot 渐进推送 */
  startSimilarAnalysis(albumId: string): Promise<void>
  /** 停止分析并保存已经计算出的指纹（离开相册或关闭相似合并时调用） */
  pauseSimilarAnalysis(albumId: string): Promise<void>
  /** 观赏窗口/细看层打开时让分析在批次间让路，关闭后继续 */
  setSimilarForeground(albumId: string, foreground: boolean): Promise<void>
  /** 告知主进程当前可见照片的下标范围，用于决定窗口与优先顺序 */
  setSimilarViewport(albumId: string, start: number, end: number): Promise<void>
  /** 订阅相似分析快照；同一时间只保留一个订阅 */
  onSimilarSnapshot(callback: (event: SimilarSnapshot) => void): void
  /** 按需读取照片详情；照片已不在登记表中时返回 null */
  getPhotoDetails(photoId: string): Promise<PhotoDetails | null>
  /** 读取全部收藏照片的 id（只写应用数据，不修改照片文件） */
  listFavorites(): Promise<string[]>
  /** 批量设置收藏状态；返回更新后的全部收藏 id */
  setFavorites(photoIds: string[], favorite: boolean): Promise<string[]>
  /** 开始或继续设备库扫描；按相册前几张参考照片归类 */
  startGearScan(refresh?: boolean): Promise<void>
  /** 暂停设备库扫描并保存已完成的相册样本 */
  pauseGearScan(): Promise<void>
  /** 订阅设备库快照；同一时间只保留一个订阅 */
  onGearSnapshot(callback: (event: GearSnapshot) => void): void
  /** 订阅后台扫描结果；同一时间只保留一个订阅 */
  onPhotosUpdated(callback: (event: PhotosUpdatedEvent) => void): void
}
