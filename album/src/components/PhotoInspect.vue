<template>
  <Teleport to="body">
    <div
      ref="overlay"
      class="inspect"
      role="dialog"
      aria-modal="true"
      aria-label="放大查看"
      tabindex="-1"
      @wheel.prevent="handleWheel"
      @click="handleBackdropClick"
    >
      <header class="inspect__top">
        <div class="inspect__meta">
          <span class="inspect__name" :title="photo.name">{{ photo.name }}</span>
          <span class="inspect__resolution">{{ resolutionLabel }}</span>
          <span class="inspect__source" :class="{ 'is-fallback': sourceError }">
            {{ sourceLabel }}
          </span>
        </div>
        <button
          class="inspect__close"
          type="button"
          title="关闭 (Esc)"
          aria-label="关闭"
          @click="close"
        >
          ×
        </button>
      </header>

      <div ref="frame" class="inspect__frame">
        <img
          ref="image"
          class="inspect__image"
          :class="{
            'is-loaded': loaded,
            'is-smooth': smooth,
            'is-zoomed': zoomed,
            'is-dragging': dragging
          }"
          :style="imageStyle"
          :src="imgSrc"
          :alt="photo.name"
          draggable="false"
          @load="handleImageLoad"
          @error="handleImageError"
          @pointerdown="handlePointerDown"
          @pointermove="handlePointerMove"
          @pointerup="handlePointerEnd"
          @pointercancel="handlePointerEnd"
          @click="handleImageClick"
          @dragstart.prevent
        />
        <span v-if="!loaded && !failed" class="inspect__spinner" aria-hidden="true" />
        <p v-if="failed" class="inspect__error">无法加载图片</p>
      </div>

      <footer class="inspect__footer">
        <div class="inspect__zoom" role="group" aria-label="缩放控制">
          <button
            class="inspect__button"
            type="button"
            title="缩小 (-)"
            aria-label="缩小"
            @click="zoomBy(1 / ZOOM_STEP)"
          >
            −
          </button>
          <button
            class="inspect__button inspect__percent"
            type="button"
            title="恢复到适应窗口 (0)"
            @click="resetZoom"
          >
            {{ percentLabel }}
          </button>
          <button
            class="inspect__button"
            type="button"
            title="放大 (+)"
            aria-label="放大"
            @click="zoomBy(ZOOM_STEP)"
          >
            +
          </button>
          <span class="inspect__divider" aria-hidden="true" />
          <button
            class="inspect__button inspect__actual"
            type="button"
            title="按原始像素显示"
            @click="showActualSize"
          >
            1:1
          </button>
        </div>
        <p class="inspect__hint">{{ hintText }}</p>
      </footer>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Photo } from '../../shared/types'
import { lockPageScroll } from '../composables/useScrollLock'

const props = defineProps<{ photo: Photo }>()
const emit = defineEmits<{ close: [] }>()

const MAX_SCALE = 16
const ZOOM_STEP = 1.4
const DRAG_THRESHOLD = 4
const PAN_STEP = 90

const overlay = ref<HTMLElement | null>(null)
const frame = ref<HTMLElement | null>(null)
const image = ref<HTMLImageElement | null>(null)

const scale = ref(1)
const offsetX = ref(0)
const offsetY = ref(0)
const smooth = ref(false)
const dragging = ref(false)
const loaded = ref(false)
const failed = ref(false)
const originalLoaded = ref(false)
const sourceError = ref(false)
const naturalWidth = ref(0)
const naturalHeight = ref(0)
/** 用户是否点了 1:1；原图替换预览后需要按真实像素重新定位 */
const wantActualSize = ref(false)
/** 先用 1920 预览顶上，原图加载完成后再无缝替换 */
const imgSrc = ref(props.photo.viewUrl)

const imageStyle = computed(() => ({
  // 使用 2D transform：3D/合成层会按原尺寸栅格化后放大，高倍缩放时明显发虚
  transform: `translate(${offsetX.value}px, ${offsetY.value}px) scale(${scale.value})`
}))

const zoomed = computed(() => scale.value > 1.001)
const percentLabel = computed(() => `${Math.round(scale.value * 100)}%`)

const resolutionLabel = computed(() =>
  naturalWidth.value > 0 && naturalHeight.value > 0
    ? `${naturalWidth.value} × ${naturalHeight.value}`
    : '—'
)

const sourceLabel = computed(() => {
  if (sourceError.value) return '预览'
  return originalLoaded.value ? '原图' : '加载原图…'
})

const hintText = computed(() => {
  if (sourceError.value) return '原图加载失败，当前使用预览图'
  if (!originalLoaded.value) return '正在加载原图…'
  return '单击放大/复位 · 拖拽平移 · Ctrl+滚轮缩放 · 点击空白返回'
})

let disposed = false
let releaseScroll: (() => void) | null = null
let previousFocus: HTMLElement | null = null
let smoothTimer: number | undefined

let dragPointer: number | null = null
let dragMoved = false
let dragStart = { x: 0, y: 0, ox: 0, oy: 0 }
/** 拖拽结束后浏览器仍可能补发一次 click，短时间内忽略，避免误触放大/复位 */
let ignoreClickUntil = 0

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function frameCenter(): { x: number; y: number } | null {
  const element = frame.value
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

function clampOffset(): void {
  const element = image.value
  const box = frame.value
  if (!element || !box) return

  const maxX = Math.max(0, (element.offsetWidth * scale.value - box.clientWidth) / 2)
  const maxY = Math.max(0, (element.offsetHeight * scale.value - box.clientHeight) / 2)
  offsetX.value = clamp(offsetX.value, -maxX, maxX)
  offsetY.value = clamp(offsetY.value, -maxY, maxY)
}

function setOffset(x: number, y: number): void {
  offsetX.value = x
  offsetY.value = y
  clampOffset()
}

function useSmoothMotion(): void {
  smooth.value = true
  window.clearTimeout(smoothTimer)
  smoothTimer = window.setTimeout(() => {
    smooth.value = false
  }, 220)
}

function stopSmoothMotion(): void {
  smooth.value = false
  window.clearTimeout(smoothTimer)
}

/** 以 anchor（屏幕坐标）为锚点缩放；不传 anchor 时以画面中心为锚点 */
function zoomTo(next: number, anchor?: { x: number; y: number }, animate = true): void {
  const target = clamp(next, 1, MAX_SCALE)
  if (Math.abs(target - scale.value) < 0.001) {
    if (target <= 1.001) {
      offsetX.value = 0
      offsetY.value = 0
    }
    return
  }

  if (animate) useSmoothMotion()
  else stopSmoothMotion()

  if (anchor) {
    const rect = image.value?.getBoundingClientRect()
    if (rect) {
      const dx = anchor.x - (rect.left + rect.width / 2)
      const dy = anchor.y - (rect.top + rect.height / 2)
      const ratio = target / scale.value
      offsetX.value += dx * (1 - ratio)
      offsetY.value += dy * (1 - ratio)
    }
  }

  scale.value = target
  if (target <= 1.001) {
    offsetX.value = 0
    offsetY.value = 0
  }
  clampOffset()
}

function zoomBy(factor: number): void {
  wantActualSize.value = false
  zoomTo(scale.value * factor, frameCenter() ?? undefined)
}

function resetZoom(): void {
  wantActualSize.value = false
  useSmoothMotion()
  scale.value = 1
  offsetX.value = 0
  offsetY.value = 0
}

/** 1 图像像素对应 1 物理屏幕像素；高 DPI 屏不能直接除以 CSS 宽度 */
function actualScale(): number {
  const element = image.value
  if (!element || element.offsetWidth === 0) return 1
  const dpr = window.devicePixelRatio || 1
  return element.naturalWidth / (element.offsetWidth * dpr)
}

function showActualSize(): void {
  const target = actualScale()
  if (!Number.isFinite(target) || target <= 0) return
  wantActualSize.value = true
  zoomTo(target, frameCenter() ?? undefined)
}

function normalizeWheel(value: number, mode: number): number {
  const multiplier = mode === 1 ? 16 : mode === 2 ? window.innerHeight : 1
  return value * multiplier
}

function handleWheel(event: WheelEvent): void {
  const deltaY = normalizeWheel(event.deltaY, event.deltaMode)
  const deltaX = normalizeWheel(event.deltaX, event.deltaMode)
  if (deltaY === 0 && deltaX === 0) return

  event.preventDefault()

  if (event.ctrlKey || event.metaKey) {
    // 触控板捏合在 Chromium 中表现为 ctrlKey + wheel
    wantActualSize.value = false
    zoomTo(scale.value * Math.exp(-deltaY * 0.0015), { x: event.clientX, y: event.clientY }, false)
    return
  }

  if (scale.value <= 1) return

  // Shift + 滚轮在没有横向增量时用于横向平移
  const shiftPan = event.shiftKey && deltaX === 0
  stopSmoothMotion()
  setOffset(
    offsetX.value - (shiftPan ? deltaY : deltaX),
    offsetY.value - (shiftPan ? 0 : deltaY)
  )
}

function handlePointerDown(event: PointerEvent): void {
  if (event.button !== 0 || scale.value <= 1) return

  dragPointer = event.pointerId
  dragMoved = false
  dragStart = { x: event.clientX, y: event.clientY, ox: offsetX.value, oy: offsetY.value }
  stopSmoothMotion()
  try {
    image.value?.setPointerCapture(event.pointerId)
  } catch {
    // 合成事件或指针已结束时无法捕获；后续 move/up 仍按 pointerId 过滤
  }
}

function handlePointerMove(event: PointerEvent): void {
  if (event.pointerId !== dragPointer) return

  const dx = event.clientX - dragStart.x
  const dy = event.clientY - dragStart.y
  if (!dragMoved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return

  dragMoved = true
  dragging.value = true
  event.preventDefault()
  setOffset(dragStart.ox + dx, dragStart.oy + dy)
}

function handlePointerEnd(event: PointerEvent): void {
  if (event.pointerId !== dragPointer) return

  dragPointer = null
  dragging.value = false
  if (dragMoved) ignoreClickUntil = performance.now() + 300
  dragMoved = false

  const element = image.value
  if (element?.hasPointerCapture(event.pointerId)) {
    element.releasePointerCapture(event.pointerId)
  }
}

/** 单击图片：适应窗口 ↔ 2x；双击时只响应第一下，避免连续切换 */
function handleImageClick(event: MouseEvent): void {
  if (performance.now() < ignoreClickUntil) return
  if (event.detail > 1) return
  event.preventDefault()
  if (zoomed.value) {
    resetZoom()
  } else {
    wantActualSize.value = false
    zoomTo(2, { x: event.clientX, y: event.clientY })
  }
}

/** 点击图片外的空白区域返回观赏窗口；顶部/底部工具栏不触发关闭 */
function handleBackdropClick(event: MouseEvent): void {
  if (performance.now() < ignoreClickUntil) return
  const target = event.target
  if (!(target instanceof Element)) return
  if (target === image.value) return
  if (target.closest('.inspect__top, .inspect__footer')) return
  close()
}

function handleImageLoad(): void {
  const element = image.value
  loaded.value = true
  failed.value = false
  if (element) {
    naturalWidth.value = element.naturalWidth
    naturalHeight.value = element.naturalHeight
  }
  // 用户可能在预览图阶段就点了 1:1；原图到位后重新按真实像素对齐
  if (wantActualSize.value) {
    zoomTo(actualScale(), frameCenter() ?? undefined)
  } else {
    clampOffset()
  }
}

function handleImageError(): void {
  // 原图失败时退回观赏窗口已经加载过的 1920 预览
  if (!sourceError.value && imgSrc.value !== props.photo.viewUrl) {
    sourceError.value = true
    imgSrc.value = props.photo.viewUrl
    return
  }
  failed.value = true
  loaded.value = true
}

function preloadOriginal(): void {
  const full = new Image()
  full.decoding = 'async'
  full.onload = () => {
    if (disposed) return
    originalLoaded.value = true
    imgSrc.value = props.photo.originalUrl
  }
  full.onerror = () => {
    if (!disposed) sourceError.value = true
  }
  full.src = props.photo.originalUrl
}

function handleResize(): void {
  if (wantActualSize.value) {
    zoomTo(actualScale(), frameCenter() ?? undefined, false)
  } else {
    clampOffset()
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    // 捕获阶段拦截，避免同一次 Esc 继续触发观赏窗口的关闭逻辑
    event.stopPropagation()
    close()
    return
  }

  if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    event.stopPropagation()
    zoomBy(ZOOM_STEP)
    return
  }

  if (event.key === '-' || event.key === '_') {
    event.preventDefault()
    event.stopPropagation()
    zoomBy(1 / ZOOM_STEP)
    return
  }

  if (event.key === '0') {
    event.preventDefault()
    event.stopPropagation()
    resetZoom()
    return
  }

  if (scale.value <= 1) return

  const step = event.shiftKey ? PAN_STEP * 3 : PAN_STEP
  let dx = 0
  let dy = 0
  if (event.key === 'ArrowLeft') dx = step
  else if (event.key === 'ArrowRight') dx = -step
  else if (event.key === 'ArrowUp') dy = step
  else if (event.key === 'ArrowDown') dy = -step
  if (dx === 0 && dy === 0) return

  event.preventDefault()
  event.stopPropagation()
  stopSmoothMotion()
  setOffset(offsetX.value + dx, offsetY.value + dy)
}

function close(): void {
  emit('close')
}

onMounted(() => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  releaseScroll = lockPageScroll()
  overlay.value?.focus()
  // 捕获阶段：细看层优先消费 Esc/方向键/缩放键
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener('resize', handleResize)
  preloadOriginal()
})

onBeforeUnmount(() => {
  disposed = true
  window.clearTimeout(smoothTimer)
  window.removeEventListener('keydown', handleKeydown, true)
  window.removeEventListener('resize', handleResize)
  releaseScroll?.()
  releaseScroll = null
  previousFocus?.focus?.()
})
</script>
