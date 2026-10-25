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
  thumbUrl: string
}

export interface AddAlbumsResult {
  albums: Album[]
  /** 本次实际新增的目录数量 */
  added: number
  /** 因重复而未添加的目录数量 */
  skipped: number
}

/** preload 暴露给渲染进程的 API */
export interface AlbumApi {
  /** 打开选择目录对话框；取消时返回 null */
  addAlbums(): Promise<AddAlbumsResult | null>
  listAlbums(): Promise<Album[]>
  removeAlbum(id: string): Promise<Album[]>
  listPhotos(albumId: string): Promise<Photo[]>
}
