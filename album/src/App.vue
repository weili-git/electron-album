<template>
  <div class="app">
    <header class="app-header">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true" />
        <div>
          <h1 class="brand__title">本地相册</h1>
          <p class="brand__subtitle">{{ subtitle }}</p>
        </div>
      </div>
      <button class="btn btn--primary" :disabled="busy" @click="handleAdd">
        {{ busy ? '正在扫描…' : '＋ 添加相册目录' }}
      </button>
    </header>

    <main class="app-main">
      <template v-if="currentAlbum">
        <div class="album-bar">
          <button class="btn btn--ghost" @click="backToLibrary">← 返回</button>
          <div class="album-bar__title">
            <h2>{{ currentAlbum.name }}</h2>
            <span class="album-bar__path" :title="currentAlbum.path">{{ currentAlbum.path }}</span>
          </div>
          <button
            class="btn btn--ghost similar-toggle"
            :class="{ 'is-active': similarEnabled, 'is-loading': similarLoading }"
            type="button"
            :aria-pressed="similarEnabled"
            :aria-busy="similarLoading"
            :title="similarTitle"
            @click="toggleSimilarity"
          >
            <span v-if="similarLoading" class="similar-toggle__dot" aria-hidden="true" />
            <span>{{ similarLabel }}</span>
            <span
              class="similar-toggle__track"
              :class="{ 'is-on': similarEnabled }"
              aria-hidden="true"
            >
              <span class="similar-toggle__knob" />
            </span>
          </button>
          <button class="btn btn--ghost" type="button" @click="showStats = true">统计</button>
          <span class="pill">{{ detailCount }} 张</span>
        </div>

        <PhotoGrid
          :photos="photos"
          :loading="photosLoading"
          :groups="similarGroups"
          :grouping="similarEnabled"
          @open="openViewer"
          @viewport="handleViewport"
        />
      </template>

      <template v-else>
        <div v-if="loading" class="state">正在扫描相册库…</div>

        <div v-else-if="albums.length === 0" class="state state--empty">
          <h2>还没有相册</h2>
          <p>点击右上角「添加相册目录」，选择一个或多个包含照片的文件夹。</p>
          <p class="state__hint">支持 JPG / PNG / WebP / GIF / TIFF，以及尼康 NEF。</p>
        </div>

        <div v-else class="album-grid">
          <AlbumCard
            v-for="album in albums"
            :key="album.id"
            :album="album"
            @open="openAlbum"
            @remove="handleRemove"
          />
        </div>
      </template>
    </main>

    <transition name="viewer">
      <PhotoViewer
        v-if="viewerIndex !== null && viewerPhotos.length > 0"
        :photos="viewerPhotos"
        :start-index="viewerIndex"
        :tag="viewerTag"
        @close="closeViewer"
      />
    </transition>

    <transition name="viewer">
      <AlbumStatsPanel
        v-if="showStats && currentAlbum"
        :album="currentAlbum"
        @close="showStats = false"
      />
    </transition>

    <transition name="toast">
      <div v-if="message" class="toast">{{ message }}</div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type {
  Album,
  Photo,
  PhotosUpdatedEvent,
  SimilarGroup,
  SimilarSnapshot
} from '../shared/types'
import AlbumCard from './components/AlbumCard.vue'
import AlbumStatsPanel from './components/AlbumStatsPanel.vue'
import PhotoGrid from './components/PhotoGrid.vue'
import PhotoViewer from './components/PhotoViewer.vue'

const albums = ref<Album[]>([])
const loading = ref(true)
const busy = ref(false)
const currentAlbum = ref<Album | null>(null)
const photos = ref<Photo[]>([])
const photosLoading = ref(false)
const viewerPhotos = ref<Photo[]>([])
const viewerIndex = ref<number | null>(null)
const viewerTag = ref('')
const showStats = ref(false)
const message = ref('')

const SIMILAR_PREFERENCE_KEY = 'album.similar.enabled'
/** 开关默认开启；关闭后记住选择，避免每次进入相册又重新分析 */
function readSimilarPreference(): boolean {
  try {
    return window.localStorage.getItem(SIMILAR_PREFERENCE_KEY) !== 'off'
  } catch {
    return true
  }
}

function saveSimilarPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(SIMILAR_PREFERENCE_KEY, enabled ? 'on' : 'off')
  } catch {
    // 忽略存储不可用，开关仍对当前会话生效
  }
}

const similarEnabled = ref(readSimilarPreference())
const similarLoading = ref(false)
const similarGroups = ref<SimilarGroup[]>([])
const similarProgress = ref<{ processed: number; total: number } | null>(null)
const similarComplete = ref(false)
/** 相册切换/暂停后丢弃旧的启动错误 */
let similarRequest = 0
/** 当前可见范围，PhotoGrid 滚动后更新；节流后发给主进程 */
let lastViewport: { start: number; end: number } | null = null
let pendingViewport: { start: number; end: number } | null = null
let similarViewportTimer: number | undefined
let similarRestartTimer: number | undefined

let messageTimer: number | undefined
/** 观赏窗口打开期间到达的后台更新，关闭后再应用 */
let pendingPhotos: Photo[] | null = null

const subtitle = computed(() => {
  if (currentAlbum.value) return currentAlbum.value.path
  if (loading.value) return '正在加载'
  return `${albums.value.length} 个相册`
})

const detailCount = computed(() => {
  if (!currentAlbum.value) return 0
  return photosLoading.value ? currentAlbum.value.photoCount : photos.value.length
})

const similarPhotoCount = computed(() =>
  similarGroups.value.reduce((sum, group) => sum + group.photoIds.length, 0)
)

const similarLabel = computed(() => {
  if (!similarEnabled.value) return '相似合并'
  if (similarLoading.value) {
    const progress = similarProgress.value
    return progress && progress.total > 0
      ? `分析中 ${progress.processed}/${progress.total}`
      : '分析中…'
  }
  return `相似合并 · ${similarGroups.value.length} 组`
})

const similarTitle = computed(() => {
  if (!similarEnabled.value) return '开启后自动分析并合并相似照片'
  if (similarLoading.value) return '正在分析相似照片；离开相册或关闭开关会暂停并保存进度'
  if (similarGroups.value.length === 0) return '没有发现相似照片；点击关闭自动合并'
  return `已合并 ${similarGroups.value.length} 组，共 ${similarPhotoCount.value} 张；点击恢复全部照片`
})

function showMessage(text: string) {
  message.value = text
  window.clearTimeout(messageTimer)
  messageTimer = window.setTimeout(() => {
    message.value = ''
  }, 2600)
}

/** 切换相册或返回首页时清空当前相册的分析状态，开关偏好保持不变 */
function resetSimilarity() {
  similarRequest += 1
  similarLoading.value = false
  similarGroups.value = []
  similarProgress.value = null
  similarComplete.value = false
  lastViewport = null
  pendingViewport = null
  if (similarViewportTimer) {
    window.clearTimeout(similarViewportTimer)
    similarViewportTimer = undefined
  }
  if (similarRestartTimer) {
    window.clearTimeout(similarRestartTimer)
    similarRestartTimer = undefined
  }
}

/** 开关关闭时暂停分析并恢复全部照片；开启时从已有快照和指纹缓存继续 */
function toggleSimilarity() {
  const album = currentAlbum.value
  if (!album) return

  if (similarEnabled.value) {
    similarEnabled.value = false
    saveSimilarPreference(false)
    similarRequest += 1
    similarLoading.value = false
    similarProgress.value = null
    void window.api.pauseSimilarAnalysis(album.id).catch(() => undefined)
    return
  }

  similarEnabled.value = true
  saveSimilarPreference(true)
  if (similarComplete.value) return
  void startSimilarAnalysis(album)
}

async function startSimilarAnalysis(album: Album) {
  if (!similarEnabled.value || currentAlbum.value?.id !== album.id) return
  // 等照片列表就绪后由 openAlbum 启动，避免拿空列表分析
  if (photosLoading.value) return
  const request = ++similarRequest
  similarLoading.value = true
  similarComplete.value = false

  try {
    await window.api.startSimilarAnalysis(album.id)
    if (
      request !== similarRequest ||
      currentAlbum.value?.id !== album.id ||
      !similarEnabled.value
    ) {
      return
    }
    if (lastViewport) {
      void window.api
        .setSimilarViewport(album.id, lastViewport.start, lastViewport.end)
        .catch(() => undefined)
    }
  } catch (error) {
    console.error(error)
    if (request === similarRequest && currentAlbum.value?.id === album.id) {
      similarLoading.value = false
      showMessage('相似照片分析失败')
    }
  }
}

function handleSimilarSnapshot(snapshot: SimilarSnapshot) {
  if (!currentAlbum.value || currentAlbum.value.id !== snapshot.albumId) return
  if (!similarEnabled.value) return

  const valid = new Set(photos.value.map((photo) => photo.id))
  similarGroups.value = snapshot.groups
    .map((group) => ({ photoIds: group.photoIds.filter((id) => valid.has(id)) }))
    .filter((group) => group.photoIds.length >= 2)
  similarProgress.value = { processed: snapshot.processed, total: snapshot.total }
  similarComplete.value = snapshot.complete
  similarLoading.value = !snapshot.complete
  if (snapshot.error) showMessage(snapshot.error)
}

/** PhotoGrid 滚动后上报可见范围；节流后让主进程下一批优先处理屏幕附近 */
function handleViewport(start: number, end: number) {
  lastViewport = { start, end }
  if (!currentAlbum.value || !similarEnabled.value) return

  pendingViewport = { start, end }
  if (similarViewportTimer) return
  similarViewportTimer = window.setTimeout(() => {
    similarViewportTimer = undefined
    const album = currentAlbum.value
    const viewport = pendingViewport
    pendingViewport = null
    if (!album || !viewport || !similarEnabled.value) return
    void window.api.setSimilarViewport(album.id, viewport.start, viewport.end).catch(() => undefined)
  }, 120)
}

/** 后台重扫增删后，用原有缓存快速重建，并继续分析新增照片 */
function scheduleSimilarRestart() {
  const album = currentAlbum.value
  if (!album || !similarEnabled.value) return

  similarComplete.value = false
  window.clearTimeout(similarRestartTimer)
  similarRestartTimer = window.setTimeout(async () => {
    similarRestartTimer = undefined
    if (!currentAlbum.value || currentAlbum.value.id !== album.id || !similarEnabled.value) return

    similarLoading.value = true
    await window.api.pauseSimilarAnalysis(album.id).catch(() => undefined)
    if (!currentAlbum.value || currentAlbum.value.id !== album.id || !similarEnabled.value) return
    void startSimilarAnalysis(album)
  }, 300)
}

async function loadAlbums() {
  loading.value = true
  try {
    albums.value = await window.api.listAlbums()
  } catch (error) {
    console.error(error)
    showMessage('读取相册库失败')
  } finally {
    loading.value = false
  }
}

async function handleAdd() {
  if (busy.value) return
  busy.value = true
  try {
    const result = await window.api.addAlbums()
    if (!result) return
    albums.value = result.albums

    if (result.added === 0) {
      showMessage('所选目录已在相册库中')
    } else if (result.skipped > 0) {
      showMessage(`已添加 ${result.added} 个相册，跳过 ${result.skipped} 个重复目录`)
    } else {
      showMessage(`已添加 ${result.added} 个相册`)
    }
  } catch (error) {
    console.error(error)
    showMessage('添加相册失败')
  } finally {
    busy.value = false
  }
}

async function openAlbum(album: Album) {
  currentAlbum.value = album
  photos.value = []
  viewerPhotos.value = []
  viewerIndex.value = null
  viewerTag.value = ''
  showStats.value = false
  pendingPhotos = null
  resetSimilarity()
  photosLoading.value = true
  try {
    // 先切换缩略图作用域，取消相册库封面等旧任务，再请求当前相册的照片
    await window.api.setThumbnailScope(album.path)
    photos.value = await window.api.listPhotos(album.id)
  } catch (error) {
    console.error(error)
    showMessage('读取照片失败')
  } finally {
    photosLoading.value = false
  }

  // 首屏照片先渲染，再自动开始相似分析；主进程会按 PhotoGrid 上报的视口优先读取
  if (currentAlbum.value?.id === album.id && similarEnabled.value && photos.value.length > 0) {
    void startSimilarAnalysis(album)
  }
}

function openViewer(nextPhotos: Photo[], index: number, tag?: string) {
  viewerPhotos.value = nextPhotos
  viewerIndex.value = index
  viewerTag.value = tag ?? ''
}

function backToLibrary() {
  const album = currentAlbum.value
  if (album) void window.api.pauseSimilarAnalysis(album.id).catch(() => undefined)

  currentAlbum.value = null
  photos.value = []
  viewerPhotos.value = []
  viewerIndex.value = null
  viewerTag.value = ''
  showStats.value = false
  pendingPhotos = null
  resetSimilarity()
  // 回到首页只需要封面缩略图，取消相册网格中排队中的任务
  void window.api.setThumbnailScope(null).catch(() => undefined)
  void loadAlbums()
}

async function handleRemove(album: Album) {
  const confirmed = window.confirm(
    `从相册库移除「${album.name}」？\n\n只会移除库记录，不会删除磁盘上的任何文件。`
  )
  if (!confirmed) return

  try {
    albums.value = await window.api.removeAlbum(album.id)
    showMessage('已从相册库移除')
  } catch (error) {
    console.error(error)
    showMessage('移除失败')
  }
}

function applyPhotosUpdate(nextPhotos: Photo[]) {
  if (!currentAlbum.value) return
  photos.value = nextPhotos
  currentAlbum.value = { ...currentAlbum.value, photoCount: nextPhotos.length }
  const album = albums.value.find((item) => item.id === currentAlbum.value?.id)
  if (album) album.photoCount = nextPhotos.length

  // 先按新列表收缩已有分组，再用缓存重建并分析新增照片
  const valid = new Set(nextPhotos.map((photo) => photo.id))
  similarGroups.value = similarGroups.value
    .map((group) => ({ photoIds: group.photoIds.filter((id) => valid.has(id)) }))
    .filter((group) => group.photoIds.length >= 2)

  if (similarEnabled.value) {
    scheduleSimilarRestart()
  } else {
    similarComplete.value = false
  }
}

function handlePhotosUpdated(event: PhotosUpdatedEvent) {
  if (!currentAlbum.value || currentAlbum.value.id !== event.albumId) return
  // 观赏窗口打开时不动底层列表，避免当前下标指向另一张照片
  if (viewerIndex.value !== null) {
    pendingPhotos = event.photos
    return
  }
  applyPhotosUpdate(event.photos)
}

function closeViewer() {
  viewerIndex.value = null
  viewerPhotos.value = []
  viewerTag.value = ''
  if (pendingPhotos) {
    applyPhotosUpdate(pendingPhotos)
    pendingPhotos = null
  }
}

onMounted(() => {
  window.api.onPhotosUpdated(handlePhotosUpdated)
  window.api.onSimilarSnapshot(handleSimilarSnapshot)
  // 首页只显示相册封面
  void window.api.setThumbnailScope(null).catch(() => undefined)
  void loadAlbums()
})
</script>
