<template>
  <div v-if="loading" class="state">正在加载照片…</div>

  <div v-else-if="photos.length === 0" class="state state--empty">
    <h2>这里还没有照片</h2>
    <p>该目录顶层没有可显示的照片，或者目录已经被移动。</p>
  </div>

  <div v-else class="photo-grid">
    <figure
      v-for="(photo, index) in photos"
      :key="photo.id"
      class="photo"
      tabindex="0"
      role="button"
      :aria-label="`查看 ${photo.name}`"
      @click="$emit('open', index)"
      @keydown.enter.prevent="$emit('open', index)"
      @keydown.space.prevent="$emit('open', index)"
    >
      <img
        :src="photo.thumbUrl"
        :alt="photo.name"
        loading="lazy"
        draggable="false"
        @error="handleError"
      />
      <figcaption class="photo__name">{{ photo.name }}</figcaption>
    </figure>
  </div>
</template>

<script setup lang="ts">
import type { Photo } from '../../shared/types'

defineProps<{
  photos: Photo[]
  loading: boolean
}>()

defineEmits<{ open: [index: number] }>()

function handleError(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  image.closest('figure')?.classList.add('is-error')
}
</script>
