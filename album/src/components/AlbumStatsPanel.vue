<template>
  <div
    ref="overlay"
    class="stats"
    role="dialog"
    aria-modal="true"
    aria-label="EXIF 统计"
    tabindex="-1"
    @click.self="close"
  >
    <section class="stats__panel">
      <header class="stats__header">
        <div class="stats__heading">
          <p class="stats__eyebrow">EXIF 统计</p>
          <h2 class="stats__title" :title="album.name">{{ album.name }}</h2>
          <p class="stats__subtitle" :title="album.path">{{ album.path }}</p>
        </div>
        <button
          class="stats__close"
          type="button"
          title="关闭 (Esc)"
          aria-label="关闭"
          @click="close"
        >
          ×
        </button>
      </header>

      <div v-if="loading" class="stats__loading">
        <div
          class="stats__progress"
          role="progressbar"
          aria-label="EXIF 读取进度"
          :aria-valuenow="progress.processed"
          :aria-valuemin="0"
          :aria-valuemax="progress.total"
        >
          <span :style="{ width: progressPercent }" />
        </div>
        <p class="stats__loading-text">
          正在读取 EXIF…
          <span v-if="progress.total">
            {{ progress.processed.toLocaleString('zh-CN') }} /
            {{ progress.total.toLocaleString('zh-CN') }}
          </span>
        </p>
        <p class="stats__hint">首次统计需要逐张读取拍摄信息；完成后会缓存，下次打开会快很多。</p>
      </div>

      <p v-else-if="error" class="stats__empty">{{ error }}</p>

      <p v-else-if="!stats || stats.photoCount === 0" class="stats__empty">
        这个相册里还没有照片。
      </p>

      <template v-else>
        <div class="stats__summary">
          <div class="stats__summary-item">
            <span class="stats__summary-label">照片</span>
            <span class="stats__summary-value">{{ formatCount(stats.photoCount) }}</span>
          </div>
          <div class="stats__summary-item">
            <span class="stats__summary-label">有拍摄信息</span>
            <span class="stats__summary-value">
              {{ formatCount(stats.withExif) }}<small>{{ withExifPercent }}</small>
            </span>
          </div>
          <div class="stats__summary-item">
            <span class="stats__summary-label">拍摄时间范围</span>
            <span class="stats__summary-value stats__summary-value--date">{{ takenRange }}</span>
          </div>
        </div>

        <p v-if="stats.withExif === 0" class="stats__empty">
          没有读取到拍摄信息。可能是图片不含 EXIF，或者在导出时被去除了。
        </p>

        <div v-else class="stats__sections">
          <section v-for="section in sections" :key="section.key" class="stats-section">
            <header class="stats-section__head">
              <h3 class="stats-section__title">{{ section.title }}</h3>
              <span v-if="section.hint" class="stats-section__hint">{{ section.hint }}</span>
            </header>
            <p v-if="section.buckets.length === 0" class="stats-section__empty">无数据</p>
            <div v-else class="stats-bars">
              <div v-for="bucket in section.buckets" :key="bucket.label" class="stats-bar">
                <span class="stats-bar__label" :title="bucket.label">{{ bucket.label }}</span>
                <span class="stats-bar__track">
                  <span class="stats-bar__fill" :style="{ width: barWidth(section, bucket) }" />
                </span>
                <span class="stats-bar__count">
                  {{ formatCount(bucket.count) }}<small>{{ barPercent(section, bucket) }}</small>
                </span>
              </div>
            </div>
          </section>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Album, AlbumStats, StatsBucket } from '../../shared/types'

const props = defineProps<{ album: Album }>()
const emit = defineEmits<{ close: [] }>()

interface StatsSection {
  key: string
  title: string
  hint?: string
  buckets: StatsBucket[]
}

const overlay = ref<HTMLElement | null>(null)
const stats = ref<AlbumStats | null>(null)
const loading = ref(true)
const error = ref('')
const progress = ref({ processed: 0, total: props.album.photoCount })

let disposed = false
let previousOverflow = ''

const progressPercent = computed(() => {
  if (progress.value.total <= 0) return '0%'
  const percent = (progress.value.processed / progress.value.total) * 100
  return `${Math.min(100, Math.max(0, percent)).toFixed(1)}%`
})

const withExifPercent = computed(() => {
  if (!stats.value || stats.value.photoCount === 0) return ''
  return `${Math.round((stats.value.withExif / stats.value.photoCount) * 100)}%`
})

const takenRange = computed(() => {
  if (!stats.value) return '—'
  const { firstTakenAt, lastTakenAt } = stats.value
  if (firstTakenAt === null && lastTakenAt === null) return '—'
  if (firstTakenAt === null) return formatDate(lastTakenAt)
  if (lastTakenAt === null) return formatDate(firstTakenAt)
  return `${formatDate(firstTakenAt)} – ${formatDate(lastTakenAt)}`
})

const sections = computed<StatsSection[]>(() => {
  const value = stats.value
  if (!value) return []
  return [
    {
      key: 'focal',
      title: '焦距',
      hint: '优先使用 35mm 等效',
      buckets: value.focalLengths
    },
    { key: 'aperture', title: '光圈', buckets: value.apertures },
    { key: 'shutter', title: '快门', buckets: value.shutterSpeeds },
    { key: 'iso', title: 'ISO', buckets: value.isos },
    { key: 'months', title: '拍摄月份', buckets: value.months },
    { key: 'hours', title: '拍摄时段', buckets: value.hours }
  ]
})

function sectionTotal(section: StatsSection): number {
  return section.buckets.reduce((sum, bucket) => sum + bucket.count, 0)
}

function sectionMax(section: StatsSection): number {
  return section.buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0) || 1
}

function barWidth(section: StatsSection, bucket: StatsBucket): string {
  return `${((bucket.count / sectionMax(section)) * 100).toFixed(1)}%`
}

function barPercent(section: StatsSection, bucket: StatsBucket): string {
  const total = sectionTotal(section)
  if (total === 0) return ''
  return `${Math.round((bucket.count / total) * 100)}%`
}

function formatCount(value: number): string {
  return value.toLocaleString('zh-CN')
}

function formatDate(timestamp: number | null): string {
  if (timestamp === null) return '—'
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

function close(): void {
  emit('close')
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    close()
  }
}

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const result = await window.api.getAlbumStats(props.album.id)
    if (!result) {
      error.value = '相册已不在库中。'
    } else {
      stats.value = result
      progress.value = { processed: result.photoCount, total: result.photoCount }
    }
  } catch (cause) {
    console.error(cause)
    error.value = '统计失败，请稍后重试。'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  window.addEventListener('keydown', handleKeydown)
  overlay.value?.focus()

  window.api.onAlbumStatsProgress((event) => {
    if (disposed || event.albumId !== props.album.id) return
    progress.value = { processed: event.processed, total: event.total }
  })
  void load()
})

onBeforeUnmount(() => {
  disposed = true
  document.body.style.overflow = previousOverflow
  window.removeEventListener('keydown', handleKeydown)
})
</script>
