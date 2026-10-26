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
      v-for="item in visiblePhotos"
      :key="item.photo.id"
      class="photo"
      :style="item.style"
      tabindex="0"
      role="button"
      :aria-label="`查看 ${item.photo.name}`"
      @click="$emit('open', item.index)"
      @keydown.enter.prevent="$emit('open', item.index)"
      @keydown.space.prevent="$emit('open', item.index)"
    >
      <img
        :src="item.photo.thumbUrl"
        :alt="item.photo.name"
        loading="lazy"
        decoding="async"
        draggable="false"
        @error="handleError"
      />
      <figcaption class="photo__name">{{ item.photo.name }}</figcaption>
    </figure>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Photo } from '../../shared/types'

const props = defineProps<{
  photos: Photo[]
  loading: boolean
}>()

defineEmits<{ open: [index: number] }>()

/** 可视区上下各多渲染几行，减少快速滚动时的空白 */
const OVERSCAN_ROWS = 3

interface VisiblePhoto {
  photo: Photo
  index: number
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

const totalRows = computed(() => Math.ceil(props.photos.length / columns.value))

const contentHeight = computed(() => {
  if (gridWidth.value <= 0 || totalRows.value === 0) return 0
  return totalRows.value * rowStride.value - gap.value
})

const visiblePhotos = computed<VisiblePhoto[]>(() => {
  const cols = columns.value
  const cell = cellSize.value
  const stride = rowStride.value
  if (cell <= 0 || stride <= 0 || props.photos.length === 0) return []

  const top = Math.max(0, viewportTop.value)
  const startRow = Math.max(0, Math.floor(top / stride) - OVERSCAN_ROWS)
  const endRow = Math.min(
    totalRows.value,
    Math.ceil((top + viewportHeight.value) / stride) + OVERSCAN_ROWS
  )
  const start = Math.min(props.photos.length, startRow * cols)
  const end = Math.min(props.photos.length, endRow * cols)

  const items: VisiblePhoto[] = []
  for (let index = start; index < end; index += 1) {
    const row = Math.floor(index / cols)
    const col = index % cols
    items.push({
      photo: props.photos[index],
      index,
      style: {
        width: `${cell}px`,
        height: `${cell}px`,
        transform: `translate(${col * stride}px, ${row * stride}px)`
      }
    })
  }
  return items
})

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

// 加载完成、照片增删（含后台 SWR 推送）后都需要重新测量
watch(
  () => [props.loading, props.photos.length],
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

function handleError(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  image.closest('figure')?.classList.add('is-error')
}
</script>
