<template>
  <article
    class="album-card"
    :class="{ 'is-missing': album.missing }"
    tabindex="0"
    @click="$emit('open', album)"
    @keydown.enter="$emit('open', album)"
  >
    <div class="album-card__cover">
      <div class="stack">
        <img
          v-for="(src, index) in album.coverThumbs"
          :key="`${album.id}-${index}`"
          class="stack__img"
          :class="`stack__img--${index}`"
          :src="src"
          :alt="`${album.name} 封面`"
          draggable="false"
          loading="lazy"
          @error="handleCoverError"
        />
        <div v-if="album.coverThumbs.length === 0" class="stack__empty">
          {{ album.missing ? '目录不可用' : '空相册' }}
        </div>
      </div>
    </div>

    <div class="album-card__meta">
      <div class="album-card__heading">
        <h3 class="album-card__name" :title="album.name">{{ album.name }}</h3>
        <span class="album-card__count">{{ album.photoCount }} 张</span>
      </div>
      <p class="album-card__path" :title="album.path">{{ album.path }}</p>
    </div>

    <button
      class="album-card__remove"
      type="button"
      title="从相册库移除"
      @click.stop="$emit('remove', album)"
    >
      ×
    </button>
  </article>
</template>

<script setup lang="ts">
import type { Album } from '../../shared/types'

defineProps<{ album: Album }>()

defineEmits<{
  open: [album: Album]
  remove: [album: Album]
}>()

function handleCoverError(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  image.style.display = 'none'
}
</script>
