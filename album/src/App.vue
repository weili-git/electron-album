<template>
  <div class="app" :class="{ 'app--album': currentAlbum || gearDeviceKey }">
    <header v-if="!currentAlbum && !gearDeviceKey" class="app-header">
      <div class="brand">
        <span class="brand__mark" aria-hidden="true" />
        <div>
          <h1 class="brand__title">本地相册</h1>
          <p class="brand__subtitle">{{ subtitle }}</p>
        </div>
      </div>
      <div class="app-header__actions">
        <div class="view-switch" role="group" aria-label="首页视图">
          <button
            class="view-switch__item"
            :class="{ 'is-active': homeView === 'albums' }"
            type="button"
            :aria-pressed="homeView === 'albums'"
            title="按加入顺序查看相册"
            @click="switchHomeView('albums')"
          >
            按相册
          </button>
          <button
            class="view-switch__item"
            :class="{ 'is-active': homeView === 'devices' }"
            type="button"
            :aria-pressed="homeView === 'devices'"
            :disabled="albums.length === 0"
            :title="albums.length === 0 ? '先添加相册目录' : '按拍摄设备查看相册'"
            @click="switchHomeView('devices')"
          >
            按设备
          </button>
        </div>
        <button class="btn btn--primary" :disabled="busy" @click="handleAdd">
          {{ busy ? '正在扫描…' : '＋ 添加相册目录' }}
        </button>
      </div>
    </header>

    <main class="app-main">
      <template v-if="currentAlbum">
        <div class="album-bar">
          <button class="btn btn--ghost" @click="backFromAlbum">← 返回</button>
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
            :disabled="favoritesOnly"
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
          <button
            class="btn btn--ghost favorites-filter"
            :class="{ 'is-active': favoritesOnly }"
            type="button"
            :aria-pressed="favoritesOnly"
            :disabled="favoriteCount === 0 && !favoritesOnly"
            :title="favoritesOnly ? '显示全部照片' : '只看收藏的照片'"
            @click="toggleFavoritesOnly"
          >
            收藏 {{ favoriteCount }}
          </button>
          <button
            class="btn btn--ghost selection-toggle"
            :class="{ 'is-active': selectionMode }"
            type="button"
            :aria-pressed="selectionMode"
            :disabled="photos.length === 0"
            :title="selectionMode ? '退出批量选择' : '批量选择照片'"
            @click="selectionMode = !selectionMode"
          >
            {{ selectionMode ? '完成' : '选择' }}
          </button>
          <button class="btn btn--ghost" type="button" @click="showStats = true">统计</button>
          <span class="pill">{{ detailCount }} 张</span>
        </div>

        <PhotoGrid
          :photos="photos"
          :loading="photosLoading"
          :groups="similarGroups"
          :grouping="similarEnabled"
          :favorites="favoriteIds"
          :favorites-only="favoritesOnly"
          v-model:selection-mode="selectionMode"
          @open="openViewer"
          @viewport="handleViewport"
          @toggle-favorite="handleFavoriteToggle"
        />
      </template>

      <template v-else-if="gearDeviceKey">
        <GearDeviceView
          :device="gearDevice"
          :snapshot="gearSnapshot"
          :albums="albums"
          @back="backToGearHome"
          @open-album="openAlbumFromGear"
        />
      </template>

      <template v-else-if="homeView === 'devices'">
        <GearLibraryView
          :snapshot="gearSnapshot"
          :albums="albums"
          :error="gearError"
          @open-device="openGearDevice"
          @open-album="openAlbumFromGear"
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
        :favorites="favoriteIds"
        @close="closeViewer"
        @toggle-favorite="handleViewerFavorite"
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
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type {
  Album,
  GearDevice,
  Photo,
  PhotosUpdatedEvent,
  SimilarGroup,
  SimilarSnapshot
} from '../shared/types'
import AlbumCard from './components/AlbumCard.vue'
import AlbumStatsPanel from './components/AlbumStatsPanel.vue'
import GearDeviceView from './components/GearDevice.vue'
import GearLibraryView from './components/GearLibrary.vue'
import PhotoGrid from './components/PhotoGrid.vue'
import PhotoViewer from './components/PhotoViewer.vue'
import { useGear } from './composables/useGear'

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
const favoriteIds = ref<Set<string>>(new Set())
const favoritesOnly = ref(false)
const selectionMode = ref(false)
/** 进入「只看收藏」前的滚动位置；关闭筛选后恢复到原处 */
let browseScrollY: number | null = null

/**
 * 首页两种视图：按相册加入顺序 / 按拍摄设备分类。
 * 设备详情是首页下的二级页面，打开相册时保留设备 key，返回后回到原处。
 */
type HomeView = 'albums' | 'devices'
const HOME_VIEW_KEY = 'album.home.view'
function readHomeView(): HomeView {
  try {
    return window.localStorage.getItem(HOME_VIEW_KEY) === 'devices' ? 'devices' : 'albums'
  } catch {
    return 'albums'
  }
}
function saveHomeView(view: HomeView): void {
  try {
    window.localStorage.setItem(HOME_VIEW_KEY, view)
  } catch {
    // 忽略存储不可用，切换仍对当前会话生效
  }
}
const homeView = ref<HomeView>(readHomeView())
const gearDeviceKey = ref<string | null>(null)
type AlbumSource = 'library' | 'gearLibrary' | 'gearDevice'
const albumSource = ref<AlbumSource>('library')
const {
  snapshot: gearSnapshot,
  error: gearError,
  start: startGear,
  pause: pauseGear,
  subscribe: subscribeGear
} = useGear()

const gearDevice = computed<GearDevice | null>(() => {
  if (!gearDeviceKey.value || !gearSnapshot.value) return null
  return (
    gearSnapshot.value.cameras.find((device) => device.key === gearDeviceKey.value) ?? null
  )
})

let albumsHomeScrollY = 0
let devicesHomeScrollY = 0
let deviceDetailScrollY = 0
let gearWasScanning = false

/** 扫描可能刷新了目录签名，完成后同步相册张数与封面 */
watch(gearSnapshot, (snapshot) => {
  if (!snapshot) return
  if (snapshot.scanning) {
    gearWasScanning = true
    return
  }
  if (!gearWasScanning) return
  gearWasScanning = false
  // 设备扫描可能刷新了目录签名，首页的设备视图需要同步张数与封面
  if (homeView.value === 'devices' && !currentAlbum.value) void loadAlbums()
})

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
const similarProgress = ref<{
  processed: number
  total: number
  windowPending: number
  windowTotal: number
} | null>(null)
const similarAlbumComplete = ref(false)
/** 相册切换/停止后丢弃旧的启动错误 */
let similarRequest = 0
/** 当前可见范围，PhotoGrid 滚动后更新；节流后发给主进程 */
let lastViewport: { start: number; end: number } | null = null
let pendingViewport: { start: number; end: number; photoIds: string[] } | null = null
let similarViewportTimer: number | undefined
let similarRestartTimer: number | undefined

/** 滚动/看图期间延后应用分组，避免虚拟滚动因组折叠而跳动 */
const GROUP_APPLY_DELAY_MS = 350
let lastViewportAt = 0
let pendingGroups: SimilarGroup[] | null = null
let groupsApplyTimer: number | undefined

let messageTimer: number | undefined
/** 观赏窗口打开期间到达的后台更新，关闭后再应用 */
let pendingPhotos: Photo[] | null = null

const subtitle = computed(() => {
  if (currentAlbum.value) return currentAlbum.value.path
  if (loading.value) return '正在加载'
  if (homeView.value === 'devices') {
    const devices = gearSnapshot.value?.cameras.length
    return devices === undefined
      ? `${albums.value.length} 个相册`
      : `${albums.value.length} 个相册 · ${devices} 台设备`
  }
  return `${albums.value.length} 个相册`
})

const detailCount = computed(() => {
  if (!currentAlbum.value) return 0
  return photosLoading.value ? currentAlbum.value.photoCount : photos.value.length
})

const similarPhotoCount = computed(() =>
  similarGroups.value.reduce((sum, group) => sum + group.photoIds.length, 0)
)

const favoriteCount = computed(() => {
  if (favoriteIds.value.size === 0) return 0
  return photos.value.reduce(
    (count, photo) => count + (favoriteIds.value.has(photo.id) ? 1 : 0),
    0
  )
})

const similarLabel = computed(() => {
  if (favoritesOnly.value) return '相似合并 · 已暂停'
  if (!similarEnabled.value) return '相似合并'
  if (similarLoading.value) {
    const progress = similarProgress.value
    if (progress && progress.windowTotal > 0) {
      const done = progress.windowTotal - progress.windowPending
      return `分析中 ${done}/${progress.windowTotal}`
    }
    return '分析中…'
  }
  return `相似合并 · ${similarGroups.value.length} 组`
})

const similarTitle = computed(() => {
  if (favoritesOnly.value) return '只看收藏时暂停相似分析，关闭筛选后自动继续'
  if (!similarEnabled.value) return '开启后自动分析并合并相似照片'
  const progress = similarProgress.value
  const analyzed = progress ? `已分析 ${progress.processed}/${progress.total} 张。` : ''
  if (similarLoading.value) {
    return '正在分析当前浏览区域；滚动会跟随，停下后自动停止'
  }
  if (similarGroups.value.length === 0) {
    return `${analyzed}当前区域没有发现相似照片`
  }
  return `${analyzed}当前已合并 ${similarGroups.value.length} 组，共 ${similarPhotoCount.value} 张；点击恢复全部照片`
})

function showMessage(text: string) {
  message.value = text
  window.clearTimeout(messageTimer)
  messageTimer = window.setTimeout(() => {
    message.value = ''
  }, 2600)
}

async function loadFavorites() {
  try {
    favoriteIds.value = new Set(await window.api.listFavorites())
  } catch (error) {
    console.error(error)
  }
}

/** 收藏只写应用数据；先本地生效，失败时按主进程状态回滚 */
async function setFavorite(photoIds: string[], favorite: boolean, notify: boolean) {
  if (photoIds.length === 0) return
  const previous = favoriteIds.value
  const next = new Set(previous)
  for (const id of photoIds) {
    if (favorite) next.add(id)
    else next.delete(id)
  }
  favoriteIds.value = next

  try {
    await window.api.setFavorites(photoIds, favorite)
    if (notify) {
      showMessage(favorite ? `已收藏 ${photoIds.length} 张` : `已取消收藏 ${photoIds.length} 张`)
    }
  } catch (error) {
    console.error(error)
    try {
      favoriteIds.value = new Set(await window.api.listFavorites())
    } catch {
      favoriteIds.value = previous
    }
    showMessage('收藏操作失败')
  }
}

/** 网格中的单张、相似组整组与批量收藏；调用方给出目标状态 */
function handleFavoriteToggle(photoIds: string[], favorite: boolean) {
  void setFavorite(photoIds, favorite, photoIds.length > 1)
}

function handleViewerFavorite(photoId: string) {
  void setFavorite([photoId], !favoriteIds.value.has(photoId), false)
}

/**
 * 「只看收藏」筛选：
 * 筛选后的网格下标与完整相册不再对应，先暂停相似分析，关闭筛选后再从缓存继续。
 */
function toggleFavoritesOnly() {
  const next = !favoritesOnly.value
  if (next) browseScrollY = window.scrollY

  favoritesOnly.value = next
  selectionMode.value = false

  if (!next) restoreBrowsePosition()

  const album = currentAlbum.value
  if (!album) return

  if (next) {
    similarRequest += 1
    similarLoading.value = false
    cancelPendingGroups()
    void window.api.pauseSimilarAnalysis(album.id).catch(() => undefined)
    return
  }

  if (similarEnabled.value && !similarAlbumComplete.value) {
    void startSimilarAnalysis(album)
  }
}

/**
 * 关闭筛选后恢复进入前的滚动位置：
 * 网格高度要等 Vue 更新 DOM 后才恢复，先等 nextTick，再在下一帧校正一次，
 * 避免浏览器仍按筛选后的旧高度把位置钳制住。
 */
function restoreBrowsePosition() {
  const target = browseScrollY
  browseScrollY = null
  if (target === null) return

  void nextTick(() => {
    window.scrollTo(0, target)
    requestAnimationFrame(() => window.scrollTo(0, target))
  })
}

function sanitizeGroups(groups: SimilarGroup[]): SimilarGroup[] {
  const valid = new Set(photos.value.map((photo) => photo.id))
  return groups
    .map((group) => ({ photoIds: group.photoIds.filter((id) => valid.has(id)) }))
    .filter((group) => group.photoIds.length >= 2)
}

function applyGroups(groups: SimilarGroup[]) {
  if (!similarEnabled.value) return
  similarGroups.value = sanitizeGroups(groups)
}

/** 滚动刚结束或观赏窗口打开时，等布局稳定后再替换分组 */
function scheduleGroupsApply(groups: SimilarGroup[]) {
  pendingGroups = groups
  queueGroupsApply()
}

function queueGroupsApply() {
  if (groupsApplyTimer) {
    window.clearTimeout(groupsApplyTimer)
    groupsApplyTimer = undefined
  }

  if (viewerIndex.value === null && Date.now() - lastViewportAt >= GROUP_APPLY_DELAY_MS) {
    flushPendingGroups()
    return
  }

  groupsApplyTimer = window.setTimeout(() => {
    groupsApplyTimer = undefined
    // 观赏窗口仍开着时继续等，closeViewer 会补上
    if (viewerIndex.value !== null) return
    // 用户还在滚动：组折叠会改变总行数，继续等滚动停下
    if (Date.now() - lastViewportAt < GROUP_APPLY_DELAY_MS) {
      queueGroupsApply()
      return
    }
    flushPendingGroups()
  }, GROUP_APPLY_DELAY_MS)
}

function flushPendingGroups() {
  if (groupsApplyTimer) {
    window.clearTimeout(groupsApplyTimer)
    groupsApplyTimer = undefined
  }
  const groups = pendingGroups
  pendingGroups = null
  if (groups) applyGroups(groups)
}

function cancelPendingGroups() {
  if (groupsApplyTimer) {
    window.clearTimeout(groupsApplyTimer)
    groupsApplyTimer = undefined
  }
  pendingGroups = null
}

/** 切换相册或返回首页时清空当前相册的分析状态，开关偏好保持不变 */
function resetSimilarity() {
  similarRequest += 1
  similarLoading.value = false
  similarGroups.value = []
  similarProgress.value = null
  similarAlbumComplete.value = false
  lastViewport = null
  pendingViewport = null
  lastViewportAt = 0
  cancelPendingGroups()
  if (similarViewportTimer) {
    window.clearTimeout(similarViewportTimer)
    similarViewportTimer = undefined
  }
  if (similarRestartTimer) {
    window.clearTimeout(similarRestartTimer)
    similarRestartTimer = undefined
  }
}

/** 开关关闭时停止分析并恢复全部照片；开启时从已有快照和指纹缓存继续 */
function toggleSimilarity() {
  const album = currentAlbum.value
  if (!album || favoritesOnly.value) return

  if (similarEnabled.value) {
    similarEnabled.value = false
    saveSimilarPreference(false)
    similarRequest += 1
    similarLoading.value = false
    similarProgress.value = null
    cancelPendingGroups()
    void window.api.pauseSimilarAnalysis(album.id).catch(() => undefined)
    return
  }

  similarEnabled.value = true
  saveSimilarPreference(true)
  if (similarAlbumComplete.value) return
  void startSimilarAnalysis(album)
}

async function startSimilarAnalysis(album: Album) {
  if (!similarEnabled.value || favoritesOnly.value || currentAlbum.value?.id !== album.id) return
  // 等照片列表就绪后由 openAlbum 启动，避免拿空列表分析
  if (photosLoading.value) return
  const request = ++similarRequest
  similarLoading.value = true
  similarAlbumComplete.value = false

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
  if (!similarEnabled.value || favoritesOnly.value) return

  similarProgress.value = {
    processed: snapshot.processed,
    total: snapshot.total,
    windowPending: snapshot.windowPending,
    windowTotal: snapshot.windowTotal
  }
  similarAlbumComplete.value = snapshot.albumComplete
  similarLoading.value = !snapshot.complete
  if (snapshot.error) showMessage(snapshot.error)

  scheduleGroupsApply(snapshot.groups)
}

/**
 * PhotoGrid 滚动后上报真实可视区：
 * - 缩略图队列对滚动延迟敏感，立即通知其优先处理屏幕内照片
 * - 相似分析窗口经 120ms 节流后切换，避免拖动时频繁重划
 */
function handleViewport(start: number, end: number, photoIds: string[]) {
  // 只看收藏时下标相对筛选后的列表，不能作为相似分析窗口
  if (!favoritesOnly.value) lastViewport = { start, end }
  lastViewportAt = Date.now()
  if (!currentAlbum.value) return

  void window.api.setThumbnailViewport(photoIds).catch(() => undefined)

  pendingViewport = { start, end, photoIds }
  if (similarViewportTimer) return
  similarViewportTimer = window.setTimeout(() => {
    similarViewportTimer = undefined
    const album = currentAlbum.value
    const viewport = pendingViewport
    pendingViewport = null
    if (!album || !viewport || !similarEnabled.value || favoritesOnly.value) return
    void window.api.setSimilarViewport(album.id, viewport.start, viewport.end).catch(() => undefined)
  }, 120)
}

/** 后台重扫增删后，用原有缓存快速重建，并继续分析新增照片 */
function scheduleSimilarRestart() {
  const album = currentAlbum.value
  if (!album || !similarEnabled.value || favoritesOnly.value) return

  similarAlbumComplete.value = false
  window.clearTimeout(similarRestartTimer)
  similarRestartTimer = window.setTimeout(async () => {
    similarRestartTimer = undefined
    if (
      !currentAlbum.value ||
      currentAlbum.value.id !== album.id ||
      !similarEnabled.value ||
      favoritesOnly.value
    ) {
      return
    }

    similarLoading.value = true
    await window.api.pauseSimilarAnalysis(album.id).catch(() => undefined)
    if (
      !currentAlbum.value ||
      currentAlbum.value.id !== album.id ||
      !similarEnabled.value ||
      favoritesOnly.value
    ) {
      return
    }
    await startSimilarAnalysis(album)
  }, 300)
}

async function loadAlbums() {
  // 已有数据时静默刷新，切换视图不会把网格短暂换成加载态
  if (albums.value.length === 0) loading.value = true
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
    // 设备视图下新增相册后立即补扫
    if (homeView.value === 'devices' && result.added > 0) void startGear()
  } catch (error) {
    console.error(error)
    showMessage('添加相册失败')
  } finally {
    busy.value = false
  }
}

async function openAlbum(album: Album, source: AlbumSource = 'library') {
  albumSource.value = source
  if (source === 'library') {
    albumsHomeScrollY = window.scrollY
  } else {
    void pauseGear()
    window.scrollTo(0, 0)
  }

  currentAlbum.value = album
  photos.value = []
  viewerPhotos.value = []
  viewerIndex.value = null
  viewerTag.value = ''
  showStats.value = false
  pendingPhotos = null
  favoritesOnly.value = false
  selectionMode.value = false
  browseScrollY = null
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

  // 首屏照片先渲染，再自动开始当前窗口的相似分析；不会继续读整本相册
  if (currentAlbum.value?.id === album.id && similarEnabled.value && photos.value.length > 0) {
    void startSimilarAnalysis(album)
  }
}

function openViewer(nextPhotos: Photo[], index: number, tag?: string) {
  viewerPhotos.value = nextPhotos
  viewerIndex.value = index
  viewerTag.value = tag ?? ''

  const album = currentAlbum.value
  if (album && similarEnabled.value) {
    void window.api.setSimilarForeground(album.id, true).catch(() => undefined)
  }
}

/** 关闭当前相册的浏览状态，根据来源决定返回相册库首页还是设备库 */
function closeAlbum() {
  const album = currentAlbum.value
  if (album) void window.api.pauseSimilarAnalysis(album.id).catch(() => undefined)

  currentAlbum.value = null
  photos.value = []
  viewerPhotos.value = []
  viewerIndex.value = null
  viewerTag.value = ''
  showStats.value = false
  pendingPhotos = null
  favoritesOnly.value = false
  selectionMode.value = false
  browseScrollY = null
  resetSimilarity()
}

/** 首页视图切换：只在设备视图启动扫描，切回相册视图时停止 */
function switchHomeView(view: HomeView) {
  if (homeView.value === view) return

  if (view === 'devices') {
    albumsHomeScrollY = window.scrollY
    homeView.value = 'devices'
    gearDeviceKey.value = null
    saveHomeView(view)
    void window.api.setThumbnailScope(null).catch(() => undefined)
    void startGear()
    void restoreScroll(devicesHomeScrollY)
    return
  }

  devicesHomeScrollY = window.scrollY
  homeView.value = 'albums'
  gearDeviceKey.value = null
  saveHomeView(view)
  void pauseGear()
  void window.api.setThumbnailScope(null).catch(() => undefined)
  void loadAlbums()
  void restoreScroll(albumsHomeScrollY)
}

function backToAlbumsHome() {
  closeAlbum()
  gearDeviceKey.value = null
  albumSource.value = 'library'
  // 回到首页只需要封面缩略图，取消相册网格中排队中的任务
  void window.api.setThumbnailScope(null).catch(() => undefined)
  void loadAlbums()
  void restoreScroll(albumsHomeScrollY)
}

function backFromAlbum() {
  if (albumSource.value === 'library') {
    backToAlbumsHome()
    return
  }

  closeAlbum()
  albumSource.value = 'library'
  // 设备视图只需要封面缩略图，取消相册网格中排队中的任务
  void window.api.setThumbnailScope(null).catch(() => undefined)
  void startGear()
  void restoreScroll(gearDeviceKey.value ? deviceDetailScrollY : devicesHomeScrollY)
}

async function openAlbumFromGear(album: Album) {
  if (gearDeviceKey.value) {
    deviceDetailScrollY = window.scrollY
  } else {
    devicesHomeScrollY = window.scrollY
  }
  await openAlbum(album, gearDeviceKey.value ? 'gearDevice' : 'gearLibrary')
}

function openGearDevice(key: string) {
  devicesHomeScrollY = window.scrollY
  gearDeviceKey.value = key
  void startGear()
  void restoreScroll(0)
}

function backToGearHome() {
  deviceDetailScrollY = window.scrollY
  gearDeviceKey.value = null
  void startGear()
  void restoreScroll(devicesHomeScrollY)
}

/**
 * 设备库页面的卡片高度依赖快照/相册列表，恢复滚动要等 DOM 更新；
 * 下一帧再校正一次，避免被尚未渲染完的网格高度钳制。
 */
async function restoreScroll(target: number) {
  await nextTick()
  window.scrollTo(0, target)
  requestAnimationFrame(() => window.scrollTo(0, target))
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

  if (similarEnabled.value && !favoritesOnly.value) {
    scheduleSimilarRestart()
  } else {
    similarAlbumComplete.value = false
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

  const album = currentAlbum.value
  if (album && similarEnabled.value) {
    void window.api.setSimilarForeground(album.id, false).catch(() => undefined)
  }

  if (pendingPhotos) {
    applyPhotosUpdate(pendingPhotos)
    pendingPhotos = null
  }
  // 观赏期间延后的分组此时再应用，避免观看过程中网格重排
  flushPendingGroups()
}

onMounted(() => {
  window.api.onPhotosUpdated(handlePhotosUpdated)
  window.api.onSimilarSnapshot(handleSimilarSnapshot)
  subscribeGear()
  // 首页只显示相册封面
  void window.api.setThumbnailScope(null).catch(() => undefined)
  void loadFavorites()
  void loadAlbums()
  // 上次停留在设备视图时直接恢复扫描，无需用户再切换
  if (homeView.value === 'devices') void startGear()
})
</script>
