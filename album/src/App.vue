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
          <button class="btn btn--ghost" type="button" @click="showStats = true">统计</button>
          <span class="pill">{{ detailCount }} 张</span>
        </div>

        <PhotoGrid :photos="photos" :loading="photosLoading" @open="openViewer" />
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
        v-if="viewerIndex !== null && photos.length > 0"
        :photos="photos"
        :start-index="viewerIndex"
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
import type { Album, Photo, PhotosUpdatedEvent } from '../shared/types'
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
const viewerIndex = ref<number | null>(null)
const showStats = ref(false)
const message = ref('')

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

function showMessage(text: string) {
  message.value = text
  window.clearTimeout(messageTimer)
  messageTimer = window.setTimeout(() => {
    message.value = ''
  }, 2600)
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
  viewerIndex.value = null
  showStats.value = false
  pendingPhotos = null
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
}

function openViewer(index: number) {
  viewerIndex.value = index
}

function backToLibrary() {
  currentAlbum.value = null
  photos.value = []
  viewerIndex.value = null
  showStats.value = false
  pendingPhotos = null
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
  if (pendingPhotos) {
    applyPhotosUpdate(pendingPhotos)
    pendingPhotos = null
  }
}

onMounted(() => {
  window.api.onPhotosUpdated(handlePhotosUpdated)
  // 首页只显示相册封面
  void window.api.setThumbnailScope(null).catch(() => undefined)
  void loadAlbums()
})
</script>
