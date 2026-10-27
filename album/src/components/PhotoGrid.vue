<template>
  <div v-if="loading" class="state">正在加载照片…</div>

  <div v-else-if="photos.length === 0" class="state state--empty">
    <h2>这里还没有照片</h2>
    <p>该目录顶层没有可显示的照片，或者目录已经被移动。</p>
  </div>

  <div
    v-else
    ref="gridEl"
    class="photo-grid"
    :style="{ height: `${contentHeight}px` }"
  >
    <figure
      v-for="item in visibleItems"
      :key="item.key"
      class="photo"
      :class="{ 'photo--group': item.grouped }"
      :style="item.style"
      tabindex="0"
      role="button"
      :aria-label="ariaLabel(item)"
      :title="item.grouped ? `${item.count} 张相似照片` : item.label"
      @click="openItem(item)"
      @keydown.enter.prevent="openItem(item)"
      @keydown.space.prevent="openItem(item)"
    >
      <template v-if="item.grouped">
        <div class="photo__stack" aria-hidden="true">
          <img
            v-for="(cover, index) in item.covers"
            :key="cover.id"
            class="photo__stack-img"
            :class="`photo__stack-img--${index}`"
            :src="cover.thumbUrl"
            alt=""
            loading="lazy"
            decoding="async"
            draggable="false"
            @error="handleStackError"
          />
        </div>
        <span class="photo__group-count">{{ item.count }} 张</span>
      </template>
      <img
        v-else
        :src="item.covers[0].thumbUrl"
        :alt="item.label"
        loading="lazy"
        decoding="async"
        draggable="false"
        @error="handleError"
      />
      <figcaption class="photo__name">{{ item.label }}</figcaption>
    </figure>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Photo, SimilarGroup } from '../../shared/types'

const props = defineProps<{
  photos: Photo[]
  loading: boolean
  /** 相似照片分组；仅在 grouping 为 true 时参与网格布局 */
  groups?: SimilarGroup[]
  grouping?: boolean
}>()

const emit = defineEmits<{
  open: [photos: Photo[], index: number, tag?: string]
  /**
   * 真实可视区的照片下标范围与可见照片 id：
   * 前者用于划定相似分析窗口，后者用于让缩略图队列优先处理屏幕内照片。
   */
  viewport: [start: number, end: number, photoIds: string[]]
}>()

/** 可视区上下各多渲染几行，减少快速滚动时的空白 */
const OVERSCAN_ROWS = 3

/** 网格中的一项：普通照片显示单图，相似组显示扑克牌叠放 */
interface GridItem {
  key: string
  /** 打开观赏窗口时使用的照片列表：普通照片为整本相册，相似组为组内成员 */
  photos: Photo[]
  /** 叠放封面，最多 3 张 */
  covers: Photo[]
  count: number
  grouped: boolean
  label: string
  /** 普通照片在相册中的下标 */
  albumIndex: number
}

interface VisibleItem extends GridItem {
  style: Record<string, string>
}

const gridEl = ref<HTMLElement | null>(null)
const gridWidth = ref(0)
const viewportTop = ref(0)
const viewportHeight = ref(0)
const minCell = ref(150)
const gap = ref(10)

let resizeObserver: ResizeObserver | null = null
let rafId = 0

/** 与 CSS 的 repeat(auto-fill, minmax(min, 1fr)) 保持一致 */
const columns = computed(() => {
  if (gridWidth.value <= 0) return 1
  return Math.max(1, Math.floor((gridWidth.value + gap.value) / (minCell.value + gap.value)))
})

const cellSize = computed(() => {
  if (gridWidth.value <= 0) return 0
  return (gridWidth.value - gap.value * (columns.value - 1)) / columns.value
})

const rowStride = computed(() => cellSize.value + gap.value)

/**
 * 把照片列表映射成网格项：
 * 相似组在组内最靠前（创建时间最新）的照片位置占一个格子，其余成员不再单独显示。
 */
const items = computed<GridItem[]>(() => {
  const photos = props.photos
  const groups = props.groups ?? []
  if (!props.grouping || groups.length === 0) {
    return photos.map((photo, index) => ({
      key: `p:${photo.id}`,
      photos,
      covers: [photo],
      count: 1,
      grouped: false,
      label: photo.name,
      albumIndex: index
    }))
  }

  const groupById = new Map<string, SimilarGroup>()
  for (const group of groups) {
    for (const id of group.photoIds) groupById.set(id, group)
  }
  const photoById = new Map(photos.map((photo) => [photo.id, photo]))
  const orderById = new Map(photos.map((photo, index) => [photo.id, index]))
  const emitted = new Set<SimilarGroup>()
  const result: GridItem[] = []

  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index]
    const group = groupById.get(photo.id)
    if (!group) {
      result.push({
        key: `p:${photo.id}`,
        photos,
        covers: [photo],
        count: 1,
        grouped: false,
        label: photo.name,
        albumIndex: index
      })
      continue
    }
    if (emitted.has(group)) continue
    emitted.add(group)

    const members = group.photoIds
      .map((id) => photoById.get(id))
      .filter((member): member is Photo => Boolean(member))
      .sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0))

    if (members.length < 2) {
      result.push({
        key: `p:${photo.id}`,
        photos,
        covers: [photo],
        count: 1,
        grouped: false,
        label: photo.name,
        albumIndex: index
      })
      continue
    }

    result.push({
      key: `g:${members[0].id}`,
      photos: members,
      covers: members.slice(0, 3),
      count: members.length,
      grouped: true,
      label: members[0].name,
      albumIndex: index
    })
  }

  return result
})

const totalRows = computed(() => Math.ceil(items.value.length / columns.value))

const contentHeight = computed(() => {
  if (gridWidth.value <= 0 || totalRows.value === 0) return 0
  return totalRows.value * rowStride.value - gap.value
})

/** 真实可视区的行范围（不含 overscan）；滚动已按行量化，同行内不会重复触发 */
const visibleRows = computed<{ firstRow: number; lastRow: number } | null>(() => {
  const stride = rowStride.value
  if (stride <= 0 || items.value.length === 0) return null
  const top = Math.max(0, viewportTop.value)
  const firstRow = Math.min(totalRows.value - 1, Math.floor(top / stride))
  const lastRow = Math.min(
    totalRows.value - 1,
    Math.max(firstRow, Math.ceil((top + viewportHeight.value) / stride) - 1)
  )
  return { firstRow, lastRow }
})

const visibleItems = computed<VisibleItem[]>(() => {
  const cols = columns.value
  const cell = cellSize.value
  const stride = rowStride.value
  const rows = visibleRows.value
  if (cell <= 0 || stride <= 0 || !rows) return []

  const startRow = Math.max(0, rows.firstRow - OVERSCAN_ROWS)
  const endRow = Math.min(totalRows.value, rows.lastRow + 1 + OVERSCAN_ROWS)
  const start = Math.min(items.value.length, startRow * cols)
  const end = Math.min(items.value.length, endRow * cols)

  const visible: VisibleItem[] = []
  for (let index = start; index < end; index += 1) {
    const row = Math.floor(index / cols)
    const col = index % cols
    visible.push({
      ...items.value[index],
      style: {
        width: `${cell}px`,
        height: `${cell}px`,
        transform: `translate(${col * stride}px, ${row * stride}px)`
      }
    })
  }
  return visible
})

/**
 * 上报真实可视区（不含 overscan）：
 * 相似组可能折叠多张照片，分析范围取可见项第一张照片的下标；
 * 缩略图优先级只关心屏幕上真正渲染出的封面。
 */
const viewportReport = computed<{
  start: number
  end: number
  photoIds: string[]
} | null>(() => {
  const rows = visibleRows.value
  if (!rows) return null
  const cols = columns.value
  const firstIndex = rows.firstRow * cols
  const lastIndex = Math.min(items.value.length, (rows.lastRow + 1) * cols)
  if (firstIndex >= lastIndex) return null

  let start = Number.POSITIVE_INFINITY
  let end = -1
  const photoIds: string[] = []
  for (let index = firstIndex; index < lastIndex; index += 1) {
    const item = items.value[index]
    if (!item) continue
    if (item.albumIndex < start) start = item.albumIndex
    if (item.albumIndex > end) end = item.albumIndex
    for (const cover of item.covers) photoIds.push(cover.id)
  }
  if (!Number.isFinite(start) || end < 0) return null
  return { start, end, photoIds }
})

let lastViewportKey = ''

watch(
  viewportReport,
  (report) => {
    if (!report) return
    const key = `${report.start}:${report.end}:${report.photoIds.join(',')}`
    if (key === lastViewportKey) return
    lastViewportKey = key
    emit('viewport', report.start, report.end, report.photoIds)
  },
  { immediate: true }
)

/** 列宽与间距由 CSS 媒体查询定义，这里读取以保证断点只有一处 */
function readMetrics(): void {
  const el = gridEl.value
  if (!el) return
  const styles = getComputedStyle(el)
  minCell.value = Number.parseFloat(styles.getPropertyValue('--photo-min-cell')) || 150
  gap.value = Number.parseFloat(styles.getPropertyValue('--photo-gap')) || 10
}

function measure(): void {
  const el = gridEl.value
  if (!el) return

  gridWidth.value = el.clientWidth
  viewportHeight.value = window.innerHeight

  const top = Math.max(0, -el.getBoundingClientRect().top)
  const stride = rowStride.value
  // 按行量化滚动位置：行窗口没变时避免每个滚动像素都重算列表
  viewportTop.value = stride > 0 ? Math.floor(top / stride) * stride : top
}

function scheduleMeasure(): void {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    measure()
  })
}

function handleResize(): void {
  readMetrics()
  scheduleMeasure()
}

watch(gridEl, (el, previous) => {
  if (previous) resizeObserver?.unobserve(previous)
  if (!el) return
  readMetrics()
  resizeObserver?.observe(el)
  measure()
})

// 加载完成、照片增删、切换相似合并后都需要重新测量
watch(
  () => [props.loading, items.value.length],
  () => {
    void nextTick(scheduleMeasure)
  }
)

onMounted(() => {
  resizeObserver = new ResizeObserver(scheduleMeasure)
  window.addEventListener('scroll', scheduleMeasure, { passive: true })
  window.addEventListener('resize', handleResize)

  if (gridEl.value) {
    readMetrics()
    resizeObserver.observe(gridEl.value)
    measure()
  }
})

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  window.removeEventListener('scroll', scheduleMeasure)
  window.removeEventListener('resize', handleResize)
})

function openItem(item: GridItem): void {
  if (item.grouped) {
    emit('open', item.photos, 0, `相似 ${item.count} 张`)
  } else {
    emit('open', item.photos, item.albumIndex)
  }
}

function ariaLabel(item: GridItem): string {
  return item.grouped
    ? `查看 ${item.count} 张相似照片`
    : `查看 ${item.label}`
}

function handleError(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  image.closest('figure')?.classList.add('is-error')
}

/** 叠放封面单张失败时只隐藏那一张，不影响整组 */
function handleStackError(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  image.style.display = 'none'
}
</script>
