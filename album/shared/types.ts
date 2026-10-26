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

/** 一组视觉上相似的照片（至少两张） */
export interface SimilarGroup {
  /** 组内照片 id，按相册默认顺序（创建时间倒序）排列 */
  photoIds: string[]
}

/** 相似照片分析的渐进快照；分析过程中会多次推送，组只会增长 */
export interface SimilarSnapshot {
  albumId: string
  groups: SimilarGroup[]
  processed: number
  total: number
  /** 整本相册的指纹都已处理（或分析出错终止） */
  complete: boolean
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
  /** 读取相册的 EXIF 统计；首次读取逐张解析，之后使用缓存 */
  getAlbumStats(albumId: string): Promise<AlbumStats | null>
  /** 订阅 EXIF 统计进度；同一时间只保留一个订阅 */
  onAlbumStatsProgress(callback: (event: AlbumStatsProgress) => void): void
  /** 开始或继续相似分析；结果通过 onSimilarSnapshot 渐进推送 */
  startSimilarAnalysis(albumId: string): Promise<void>
  /** 暂停分析并保存已经计算出的指纹 */
  pauseSimilarAnalysis(albumId: string): Promise<void>
  /** 告知主进程当前可见照片的下标范围，用于优先计算屏幕附近 */
  setSimilarViewport(albumId: string, start: number, end: number): Promise<void>
  /** 订阅相似分析快照；同一时间只保留一个订阅 */
  onSimilarSnapshot(callback: (event: SimilarSnapshot) => void): void
  /** 按需读取照片详情；照片已不在登记表中时返回 null */
  getPhotoDetails(photoId: string): Promise<PhotoDetails | null>
  /** 订阅后台扫描结果；同一时间只保留一个订阅 */
  onPhotosUpdated(callback: (event: PhotosUpdatedEvent) => void): void
}
