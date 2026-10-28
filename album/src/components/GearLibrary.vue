<template>
  <section class="gear-page">
    <div v-if="showProgress" class="gear-progress">
      <div class="gear-progress__track">
        <div class="gear-progress__fill" :style="{ width: `${progressPercent}%` }" />
      </div>
      <span class="gear-progress__text">{{ progressText }}</span>
    </div>

    <p v-if="snapshot?.error || error" class="gear-error">{{ snapshot?.error ?? error }}</p>

    <section v-if="devices.length > 0" class="gear-section">
      <div class="gear-section__head">
        <h3
          title="按每个相册前几张照片的 EXIF 机身信息归类；样本冲突时标为混合。镜头信息来自参考样本和相似分析已读取的照片，随浏览逐步补全。"
        >
          设备
        </h3>
        <span>{{ devices.length }} 台 · 约 {{ totalPhotos }} 张</span>
      </div>
      <div class="gear-device-grid">
        <article
          v-for="device in devices"
          :key="device.key"
          class="gear-device"
          tabindex="0"
          @click="$emit('openDevice', device.key)"
          @keydown.enter="$emit('openDevice', device.key)"
        >
          <div class="gear-device__top">
            <div class="gear-device__cover" aria-hidden="true">
              <img
                v-if="deviceImage(device)"
                class="gear-device__photo"
                :src="deviceImage(device) ?? undefined"
                alt=""
                draggable="false"
              />
              <svg v-else class="gear-device__icon" viewBox="0 0 48 48" fill="none">
                <rect x="5" y="15" width="38" height="23" rx="6" />
                <path d="M16.5 15 19 9.5h10L31.5 15" />
                <circle cx="24" cy="26.5" r="7.6" />
                <circle cx="24" cy="26.5" r="3.6" />
                <circle class="gear-device__icon-dot" cx="37.5" cy="19.8" r="1.2" />
              </svg>
            </div>
            <div class="gear-device__body">
              <h3 class="gear-device__name" :title="device.name">{{ device.name }}</h3>
              <p class="gear-device__count">
                {{ device.albumCount }} 个相册 · 约 {{ device.photoCount }} 张
              </p>
              <p v-if="device.mixedAlbumCount > 0" class="gear-device__warn">
                {{ device.mixedAlbumCount }} 个相册参考样本混合
              </p>
            </div>
          </div>

          <div v-if="device.referenceLenses.length > 0" class="gear-device__lenses">
            <div class="gear-device__lens-head">
              <span>镜头</span>
              <span>已读取 {{ device.lensPhotoCount }} 张</span>
            </div>
            <div
              v-for="lens in visibleLenses(device)"
              :key="lens.label"
              class="gear-lens-row"
            >
              <span class="gear-lens-row__name" :title="lens.label">{{ lens.label }}</span>
              <span class="gear-lens-row__count">{{ lens.count }} 张</span>
            </div>
            <button
              v-if="device.referenceLenses.length > LENS_PREVIEW"
              class="gear-lens-toggle"
              type="button"
              :aria-expanded="expandedLensKeys.has(device.key)"
              @click.stop="toggleLenses(device.key)"
              @keydown.enter.stop
            >
              {{
                expandedLensKeys.has(device.key)
                  ? '收起 ▴'
                  : `还有 ${device.referenceLenses.length - LENS_PREVIEW} 支镜头 ▾`
              }}
            </button>
          </div>
          <p v-else class="gear-device__lenses gear-device__muted">暂无镜头信息</p>
        </article>
      </div>
    </section>

    <section v-if="otherAlbums.length > 0" class="gear-section">
      <div class="gear-section__head">
        <h3>其他相册</h3>
        <span>{{ otherAlbums.length }} 个</span>
      </div>
      <p class="gear-section__desc">没有读到机身信息、目录不可用或暂时为空的相册</p>
      <div class="album-grid">
        <AlbumCard
          v-for="album in otherAlbums"
          :key="album.id"
          :album="album"
          :removable="false"
          :note="otherNote(album)"
          :note-tone="otherTone(album)"
          @open="$emit('openAlbum', $event)"
        />
      </div>
    </section>

    <div v-if="showEmpty" class="state">
      <template v-if="snapshot && snapshot.totalAlbums === 0">
        <h2>相册库还是空的</h2>
        <p>在首页添加相册目录后，这里会按机身自动归类。</p>
      </template>
      <template v-else>
        <h2>还没有识别出设备</h2>
        <p>参考照片没有读到相机型号，可以在相册详情里查看单张照片的 EXIF。</p>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue'
import type { Album, GearDevice, GearSnapshot } from '../../shared/types'
import { gearImageUrl } from '../gearImages'
import AlbumCard from './AlbumCard.vue'

const props = defineProps<{
  snapshot: GearSnapshot | null
  albums: Album[]
  error: string | null
}>()

defineEmits<{
  openDevice: [key: string]
  openAlbum: [album: Album]
}>()

const albumMap = computed(() => new Map(props.albums.map((album) => [album.id, album])))

const devices = computed(() => props.snapshot?.cameras ?? [])
const scanning = computed(() => props.snapshot?.scanning ?? true)
const showProgress = computed(() => !props.snapshot || props.snapshot.scanning)

const totalPhotos = computed(() =>
  devices.value.reduce((sum, device) => sum + device.photoCount, 0)
)

const progressText = computed(() => {
  const snapshot = props.snapshot
  if (!snapshot) return '正在读取设备信息…'
  if (snapshot.scanning) {
    return `正在检查 ${snapshot.checkedAlbums}/${snapshot.totalAlbums} 个相册`
  }
  if (snapshot.checkedAlbums < snapshot.totalAlbums) {
    return `已检查 ${snapshot.checkedAlbums}/${snapshot.totalAlbums} 个相册`
  }
  return `已检查 ${snapshot.totalAlbums} 个相册`
})

const progressPercent = computed(() => {
  const snapshot = props.snapshot
  if (!snapshot) return 0
  if (snapshot.totalAlbums === 0) return 100
  return Math.round((snapshot.checkedAlbums / snapshot.totalAlbums) * 100)
})

const otherAlbums = computed(() => {
  const snapshot = props.snapshot
  if (!snapshot) return []
  const ids = [...snapshot.unknownAlbumIds, ...snapshot.missingAlbumIds]
  return ids
    .map((id) => albumMap.value.get(id))
    .filter((album): album is Album => Boolean(album))
})

const showEmpty = computed(
  () =>
    Boolean(props.snapshot) &&
    !scanning.value &&
    devices.value.length === 0 &&
    otherAlbums.value.length === 0
)

/** 设备卡片默认只展开照片最多的 2 支镜头，其余点开再看（测试：临时从 3 改为 2） */
const LENS_PREVIEW = 2
const expandedLensKeys = reactive(new Set<string>())

function visibleLenses(device: GearDevice) {
  return expandedLensKeys.has(device.key)
    ? device.referenceLenses
    : device.referenceLenses.slice(0, LENS_PREVIEW)
}

/** 有内置官方产品图时优先使用，否则回退到相机 SVG */
function deviceImage(device: GearDevice): string | null {
  return gearImageUrl(device)
}

function toggleLenses(key: string) {
  if (expandedLensKeys.has(key)) expandedLensKeys.delete(key)
  else expandedLensKeys.add(key)
}

function otherNote(album: Album): string {
  if (album.missing) return '目录不可用'
  if (album.photoCount === 0) return '空相册'
  return ''
}

function otherTone(album: Album): 'muted' | 'warn' {
  return album.missing ? 'warn' : 'muted'
}
</script>
