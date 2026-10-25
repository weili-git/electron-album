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

/** preload 暴露给渲染进程的 API */
export interface AlbumApi {
  /** 打开选择目录对话框；取消时返回 null */
  addAlbums(): Promise<AddAlbumsResult | null>
  listAlbums(): Promise<Album[]>
  removeAlbum(id: string): Promise<Album[]>
  listPhotos(albumId: string): Promise<Photo[]>
  /** 按需读取照片详情；照片已不在登记表中时返回 null */
  getPhotoDetails(photoId: string): Promise<PhotoDetails | null>
}
