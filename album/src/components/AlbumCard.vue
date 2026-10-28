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
      <p
        v-if="note"
        class="album-card__note"
        :class="`album-card__note--${noteTone}`"
        :title="note"
      >
        {{ note }}
      </p>
      <p
        v-if="noteDetail"
        class="album-card__note album-card__note--detail"
        :title="noteDetail"
      >
        {{ noteDetail }}
      </p>
    </div>

    <button
      v-if="removable"
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

withDefaults(
  defineProps<{
    album: Album
    /** 设备库等只读页面隐藏移除按钮 */
    removable?: boolean
    /** 卡片底部的附加说明，例如设备库的参考样本结论 */
    note?: string
    /** 附加说明的第二行，用于较长的镜头名或机身分布 */
    noteDetail?: string
    noteTone?: 'muted' | 'warn'
  }>(),
  { removable: true, note: '', noteDetail: '', noteTone: 'muted' }
)

defineEmits<{
  open: [album: Album]
  remove: [album: Album]
}>()

function handleCoverError(event: Event) {
  const image = event.currentTarget as HTMLImageElement
  image.style.display = 'none'
}
</script>
