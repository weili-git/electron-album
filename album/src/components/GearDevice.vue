<template>
  <section class="gear-page">
    <div class="album-bar">
      <button class="btn btn--ghost" type="button" @click="$emit('back')">← 设备列表</button>
      <div class="album-bar__title">
        <h2>{{ device?.name ?? '设备' }}</h2>
        <span class="album-bar__path">{{ summary }}</span>
      </div>
      <span v-if="scanning" class="pill pill--active">扫描中</span>
      <span class="pill">{{ device?.albumCount ?? 0 }} 个相册</span>
    </div>

    <div v-if="device && device.referenceLenses.length > 0" class="gear-lenses">
      <span class="gear-lenses__label">镜头</span>
      <span
        v-for="lens in visibleLenses"
        :key="lens.label"
        class="gear-chip"
        :title="`${lens.label}（${lens.count} 张已读取）`"
      >
        <span class="gear-chip__label">{{ lens.label }}</span>
        <small>{{ lens.count }} 张</small>
      </span>
      <button
        v-if="(device?.referenceLenses.length ?? 0) > LENS_PREVIEW"
        class="gear-chip gear-chip--toggle"
        type="button"
        :aria-expanded="lensesExpanded"
        @click="lensesExpanded = !lensesExpanded"
      >
        {{
          lensesExpanded
            ? '收起 ▴'
            : `还有 ${(device?.referenceLenses.length ?? 0) - LENS_PREVIEW} 支 ▾`
        }}
      </button>
    </div>

    <p v-if="device && device.mixedAlbumCount > 0" class="gear-hint gear-hint--warn">
      有 {{ device.mixedAlbumCount }} 个相册的参考样本来自多台机身，已按多数票归到这台设备。
    </p>

    <div v-if="albums.length > 0" class="album-grid">
      <AlbumCard
        v-for="album in albums"
        :key="album.id"
        :album="album"
        :removable="false"
        :note="noteFor(album)"
        :note-detail="detailFor(album)"
        :note-tone="toneFor(album)"
        @open="$emit('openAlbum', $event)"
      />
    </div>

    <div v-else-if="device" class="state">
      <h2>正在整理相册</h2>
      <p>设备信息已识别，相册列表会在扫描完成后出现。</p>
    </div>

    <div v-else class="state">
      <h2>设备数据正在更新</h2>
      <p>相册库变化后设备可能已不存在，请返回设备库重新查看。</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type {
  Album,
  GearAlbumInfo,
  GearDevice,
  GearSnapshot
} from '../../shared/types'
import AlbumCard from './AlbumCard.vue'

const props = defineProps<{
  device: GearDevice | null
  snapshot: GearSnapshot | null
  albums: Album[]
}>()

defineEmits<{
  back: []
  openAlbum: [album: Album]
}>()

const albumMap = computed(() => new Map(props.albums.map((album) => [album.id, album])))

const infoMap = computed(
  () => new Map((props.snapshot?.albums ?? []).map((info) => [info.albumId, info]))
)

const albums = computed(() => {
  if (!props.device) return []
  return props.device.albumIds
    .map((id) => albumMap.value.get(id))
    .filter((album): album is Album => Boolean(album))
})

const scanning = computed(() => props.snapshot?.scanning ?? false)

/** 顶部镜头默认只列 2 支，其余折叠（测试：临时从 3 改为 2） */
const LENS_PREVIEW = 2
const lensesExpanded = ref(false)
const visibleLenses = computed(() => {
  const lenses = props.device?.referenceLenses ?? []
  return lensesExpanded.value ? lenses : lenses.slice(0, LENS_PREVIEW)
})

const summary = computed(() => {
  if (!props.device) return '等待设备数据'
  return `${props.device.albumCount} 个相册 · 约 ${props.device.photoCount} 张 · 参考 ${props.device.sampleCount} 张样本 · 镜头读自 ${props.device.lensPhotoCount} 张`
})

/** 第一行只放结论，较长或较多的镜头/机身信息留到第二行 */
function noteFor(album: Album): string {
  const info = infoMap.value.get(album.id)
  if (!info) return scanning.value ? '正在识别参考样本…' : '没有参考样本'
  const verdict = info.mixed ? `混合 · ${info.cameras.length} 台机身` : '一致'
  return `参考 ${info.sampleCount} 张 · ${verdict}`
}

function detailFor(album: Album): string {
  const info = infoMap.value.get(album.id)
  if (!info) return ''
  if (info.mixed) {
    return info.cameras.map((camera) => `${camera.label} ×${camera.count}`).join(' / ')
  }
  return info.referenceLens ?? '暂无镜头信息'
}

function toneFor(album: Album): 'muted' | 'warn' {
  const info: GearAlbumInfo | undefined = infoMap.value.get(album.id)
  return info?.mixed ? 'warn' : 'muted'
}
</script>
