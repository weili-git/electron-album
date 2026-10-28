import type { GearDevice } from '../shared/types'

/**
 * 机身官方产品图放在 `src/assets/gear/`，构建时由 Vite 打成静态资源。
 * 文件名（不含扩展名）按机身型号匹配，忽略大小写、空格与标点：
 * `nikon-z30.webp`、`nikon-z-30.png` 都能匹配 `NIKON Z 30`。
 * 同一机型有多个候选时取文件名最长的那个（更具体）。
 */
const modules = import.meta.glob('./assets/gear/*.{png,jpg,jpeg,webp,avif}', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

/** 型号写法与文件名差异较大时在此显式指定，key 为归一化后的机身名 */
const ALIASES: Record<string, string> = {
  // 尼康 EXIF 里的 Z6III 写作 Z6_3
  nikonz63: 'nikon-z6iii'
}

function compact(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

const images = Object.entries(modules).map(([path, url]) => {
  const file = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '')
  return { file, slug: compact(file), url }
})

/** 返回设备对应的官方产品图；没有匹配到则返回 null，由调用方回退到 SVG 图标 */
export function gearImageUrl(device: Pick<GearDevice, 'key' | 'name'>): string | null {
  const candidates = [compact(device.key), compact(device.name)].filter(Boolean)
  let best: { url: string; length: number } | null = null

  for (const image of images) {
    if (!image.slug) continue
    for (const candidate of candidates) {
      const aliased = ALIASES[candidate]
      const matched =
        aliased === image.file ||
        candidate === image.slug ||
        candidate.endsWith(image.slug)
      if (matched && (!best || image.slug.length > best.length)) {
        best = { url: image.url, length: image.slug.length }
      }
    }
  }

  return best?.url ?? null
}
