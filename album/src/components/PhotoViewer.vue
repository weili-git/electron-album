<template>
  <div
    ref="overlay"
    class="viewer"
    role="dialog"
    aria-modal="true"
    aria-label="照片预览"
    tabindex="-1"
    @click.self="close"
  >
    <button class="viewer__close" type="button" title="关闭 (Esc)" aria-label="关闭" @click="close">
      ×
    </button>

    <button
      class="viewer__nav viewer__nav--prev"
      type="button"
      title="上一张 (←)"
      aria-label="上一张"
      :disabled="currentIndex === 0"
      @click.stop="step(-1)"
    >
      ‹
    </button>

    <div class="viewer__stage" @click.stop>
      <div class="viewer__card" :class="{ 'is-flipped': flipped }">
        <button
          class="viewer__face viewer__face--front"
          type="button"
          :tabindex="flipped ? -1 : 0"
          :aria-label="`查看 ${currentPhoto.name} 的详细信息`"
          title="点击翻转查看详细信息"
          @click="toggleFlip"
        >
          <img
            :key="currentPhoto.id"
            class="viewer__image"
            :class="{ 'is-loaded': loaded }"
            :src="currentPhoto.viewUrl"
            :alt="currentPhoto.name"
            draggable="false"
            @load="handleLoad"
            @error="handleError"
          />
          <span v-if="failed" class="viewer__error">无法加载高清预览</span>
        </button>

        <div
          ref="backFace"
          class="viewer__face viewer__face--back"
          :tabindex="flipped ? 0 : -1"
          :aria-hidden="!flipped"
          title="点击任意处返回照片"
          @click.stop="showPhoto"
          @keydown.enter.prevent="showPhoto"
          @keydown.space.prevent="showPhoto"
        >
          <div class="photo-info">
            <header class="photo-info__head">
              <div class="photo-info__heading">
                <p class="photo-info__eyebrow">照片信息</p>
                <h3 class="photo-info__name" :title="currentPhoto.name">{{ currentPhoto.name }}</h3>
              </div>
              <span class="photo-info__return">点击任意处返回</span>
            </header>

            <div v-if="detailsLoading" class="photo-info__skeleton" aria-hidden="true">
              <span v-for="n in 6" :key="n" />
            </div>

            <p v-else-if="!details" class="photo-info__empty">无法读取这张照片的详细信息。</p>

            <template v-else>
              <section v-if="hasShooting(details)" class="photo-info__section">
                <h4 class="photo-info__title">拍摄</h4>
                <p v-if="details.takenAt !== null" class="photo-info__date">
                  {{ formatDateTime(details.takenAt) }}
                </p>
                <p v-if="details.camera" class="photo-info__camera">{{ details.camera }}</p>
                <p v-if="details.lens" class="photo-info__lens" :title="details.lens">
                  {{ details.lens }}
                </p>

                <dl class="photo-info__specs">
                  <div v-if="details.focalLength !== null">
                    <dt>焦距</dt>
                    <dd>
                      {{ trimNumber(details.focalLength) }} mm
                      <small v-if="details.focalLength35 !== null">
                        ≈ {{ trimNumber(details.focalLength35) }} mm
                      </small>
                    </dd>
                  </div>
                  <div v-if="details.aperture !== null">
                    <dt>光圈</dt>
                    <dd>ƒ/{{ trimNumber(details.aperture) }}</dd>
                  </div>
                  <div v-if="details.shutterSeconds !== null">
                    <dt>快门</dt>
                    <dd>{{ formatShutter(details.shutterSeconds) }}</dd>
                  </div>
                  <div v-if="details.iso !== null">
                    <dt>ISO</dt>
                    <dd>{{ Math.round(details.iso) }}</dd>
                  </div>
                  <div v-if="details.exposureBias !== null && details.exposureBias !== 0">
                    <dt>曝光补偿</dt>
                    <dd>{{ formatBias(details.exposureBias) }}</dd>
                  </div>
                </dl>
              </section>

              <section class="photo-info__section">
                <h4 class="photo-info__title">图像</h4>
                <dl class="photo-info__rows">
                  <div v-if="details.width !== null && details.height !== null">
                    <dt>尺寸</dt>
                    <dd>{{ details.width }} × {{ details.height }}</dd>
                  </div>
                  <div>
                    <dt>格式</dt>
                    <dd>{{ details.format }}</dd>
                  </div>
                  <div>
                    <dt>大小</dt>
                    <dd>{{ formatBytes(details.sizeBytes) }}</dd>
                  </div>
                  <div>
                    <dt>修改时间</dt>
                    <dd>{{ formatDateTime(details.modifiedAt) }}</dd>
                  </div>
                </dl>
              </section>

              <p v-if="!hasShooting(details)" class="photo-info__hint">这张图片没有拍摄信息。</p>
            </template>
          </div>
        </div>
      </div>

      <div v-if="!loaded && !failed && !flipped" class="viewer__spinner" aria-hidden="true" />
    </div>

    <button
      class="viewer__nav viewer__nav--next"
      type="button"
      title="下一张 (→)"
      aria-label="下一张"
      :disabled="currentIndex === photos.length - 1"
      @click.stop="step(1)"
    >
      ›
    </button>

    <footer class="viewer__footer">
      <span class="viewer__name" :title="currentPhoto.name">{{ currentPhoto.name }}</span>
      <span class="viewer__counter">{{ currentIndex + 1 }} / {{ photos.length }}</span>
      <button
        class="viewer__flip"
        type="button"
        :aria-pressed="flipped"
        :title="flipped ? '翻转回照片 (F)' : '翻转查看详细信息 (F)'"
        @click="toggleFlip"
      >
        {{ flipped ? '返回' : '详情' }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Photo, PhotoDetails } from '../../shared/types'

const props = defineProps<{
  photos: Photo[]
  /** 打开时定位到第几张（从 0 开始） */
  startIndex: number
}>()

const emit = defineEmits<{ close: [] }>()

const overlay = ref<HTMLElement | null>(null)
const backFace = ref<HTMLElement | null>(null)
const currentIndex = ref(
  Math.min(Math.max(props.startIndex, 0), Math.max(props.photos.length - 1, 0))
)
const loaded = ref(false)
const failed = ref(false)
const flipped = ref(false)
const details = ref<PhotoDetails | null>(null)
const detailsLoading = ref(false)

/** 本次观赏会话内的详情缓存，翻页来回不会重复读盘 */
const detailsCache = new Map<string, PhotoDetails | null>()
let detailRequest = 0

const currentPhoto = computed(() => props.photos[currentIndex.value])

function close() {
  emit('close')
}

function toggleFlip() {
  flipped.value = !flipped.value
  if (flipped.value && backFace.value) backFace.value.scrollTop = 0
}

function showPhoto() {
  flipped.value = false
  overlay.value?.focus()
}

function step(delta: number) {
  const next = currentIndex.value + delta
  if (next < 0 || next >= props.photos.length) return
  loaded.value = false
  failed.value = false
  flipped.value = false
  if (backFace.value) backFace.value.scrollTop = 0
  currentIndex.value = next
  void loadDetails(currentPhoto.value)
  prefetchAdjacent()
}

function handleLoad() {
  loaded.value = true
}

function handleError() {
  loaded.value = true
  failed.value = true
}

async function loadDetails(photo: Photo | undefined) {
  if (!photo) return

  if (detailsCache.has(photo.id)) {
    details.value = detailsCache.get(photo.id) ?? null
    detailsLoading.value = false
    return
  }

  const request = ++detailRequest
  details.value = null
  detailsLoading.value = true
  try {
    const value = await window.api.getPhotoDetails(photo.id)
    detailsCache.set(photo.id, value)
    if (request === detailRequest) details.value = value
  } catch (error) {
    console.error(error)
    detailsCache.set(photo.id, null)
    if (request === detailRequest) details.value = null
  } finally {
    if (request === detailRequest) detailsLoading.value = false
  }
}

/* ---------- 滚轮翻页 ---------- */

const WHEEL_STEP_THRESHOLD = 40
const WHEEL_STEP_COOLDOWN = 320
let wheelAccumulator = 0
let wheelDirection = 0
let wheelLastStep = 0
let wheelTarget: HTMLElement | null = null

function normalizeWheelDelta(event: WheelEvent): number {
  const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
  return event.deltaY * multiplier
}

function canScrollDetails(deltaY: number): boolean {
  const back = backFace.value
  if (!back || back.scrollHeight <= back.clientHeight + 1) return false
  return deltaY < 0
    ? back.scrollTop > 0
    : back.scrollTop + back.clientHeight < back.scrollHeight - 1
}

function handleWheel(event: WheelEvent) {
  const back = backFace.value
  // 详情内容可以滚动时优先滚动内容，滚到边界再翻页
  if (
    flipped.value &&
    back &&
    event.target instanceof Node &&
    back.contains(event.target) &&
    canScrollDetails(event.deltaY)
  ) {
    return
  }

  const delta = normalizeWheelDelta(event)
  if (delta === 0) return
  event.preventDefault()

  const now = performance.now()
  if (now - wheelLastStep < WHEEL_STEP_COOLDOWN) return

  const direction = delta > 0 ? 1 : -1
  if (wheelDirection !== 0 && wheelDirection !== direction) wheelAccumulator = 0
  wheelDirection = direction
  wheelAccumulator += delta

  if (Math.abs(wheelAccumulator) < WHEEL_STEP_THRESHOLD) return
  wheelAccumulator = 0
  wheelLastStep = now
  step(direction)
}

/** 预加载前后各一张，翻页更顺畅 */
function prefetchAdjacent() {
  for (const offset of [-1, 1]) {
    const photo = props.photos[currentIndex.value + offset]
    if (photo) {
      const image = new Image()
      image.src = photo.viewUrl
    }
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    if (flipped.value) {
      showPhoto()
    } else {
      close()
    }
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    step(-1)
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    step(1)
  } else if (event.key === 'f' || event.key === 'F' || event.key === 'i' || event.key === 'I') {
    event.preventDefault()
    toggleFlip()
  } else if (
    (event.key === 'Enter' || event.key === ' ') &&
    document.activeElement === overlay.value
  ) {
    event.preventDefault()
    toggleFlip()
  }
}

function hasShooting(info: PhotoDetails): boolean {
  return (
    info.takenAt !== null ||
    info.camera !== null ||
    info.lens !== null ||
    info.focalLength !== null ||
    info.aperture !== null ||
    info.shutterSeconds !== null ||
    info.iso !== null
  )
}

function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function trimNumber(value: number): string {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(1)))
}

function formatShutter(seconds: number): string {
  if (seconds <= 0) return '—'
  if (seconds >= 1) return `${trimNumber(Number(seconds.toFixed(1)))} s`

  const inverse = 1 / seconds
  const denominator = Math.round(inverse)
  if (denominator > 0 && Math.abs(inverse - denominator) / inverse < 0.05) {
    return `1/${denominator} s`
  }
  return `${trimNumber(Number(seconds.toFixed(2)))} s`
}

function formatBias(bias: number): string {
  const rounded = Number(bias.toFixed(1))
  return `${rounded > 0 ? '+' : ''}${trimNumber(rounded)} EV`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  const digits = value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${units[index]}`
}

let previousOverflow = ''

onMounted(() => {
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', handleKeydown)
  wheelTarget = overlay.value
  wheelTarget?.addEventListener('wheel', handleWheel, { passive: false })
  overlay.value?.focus()
  prefetchAdjacent()
  void loadDetails(currentPhoto.value)
})

onBeforeUnmount(() => {
  document.body.style.overflow = previousOverflow
  window.removeEventListener('keydown', handleKeydown)
  wheelTarget?.removeEventListener('wheel', handleWheel)
})
</script>
