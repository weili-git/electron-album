import sharp from 'sharp'
import type { SimilarGroup } from '../shared/types'

// 与缩略图生成保持一致：并发由调用方的任务数控制，sharp 内部不再按 CPU 核数叠加
sharp.concurrency(1)

/** 感知哈希使用 32×32 RGB 图，取灰度 DCT 左上角 8×8 低频系数组成 64 bit */
const HASH_SIZE = 32
const DCT_SIZE = 8
/** 颜色签名：4×4 网格，每格取 RGB 平均值，用来区分结构相近但颜色不同的画面 */
const COLOR_GRID_SIZE = 4
const COLOR_BLOCK_SIZE = HASH_SIZE / COLOR_GRID_SIZE
const COLOR_VALUE_COUNT = COLOR_GRID_SIZE * COLOR_GRID_SIZE * 3

/**
 * pHash 阈值：越小越严格。18 能覆盖曝光/压缩/姿态变化，
 * 颜色签名负责把月亮与夕阳这类结构相近但颜色不同的画面分开。
 */
export const SIMILAR_THRESHOLD = 18
/** 颜色距离阈值：48 个分量的平均每通道绝对差 */
export const SIMILAR_COLOR_THRESHOLD = 30
/**
 * 组内允许比阈值多 2 bit 的直径。新照片必须与组内某一张足够相似，
 * 同时与所有成员都不超过这个距离，避免 A≈B、B≈C 通过链式关系把 A/C 并进同组。
 */
const SIMILAR_DIAMETER_SLACK = 2

const DCT_COS = (() => {
  const table = new Float64Array(DCT_SIZE * HASH_SIZE)
  for (let u = 0; u < DCT_SIZE; u += 1) {
    const alpha = u === 0 ? Math.SQRT1_2 : 1
    for (let x = 0; x < HASH_SIZE; x += 1) {
      table[u * HASH_SIZE + x] =
        Math.cos(((2 * x + 1) * u * Math.PI) / (2 * HASH_SIZE)) * alpha
    }
  }
  return table
})()

const POPCOUNT = (() => {
  const table = new Uint8Array(1 << 16)
  for (let value = 1; value < table.length; value += 1) {
    table[value] = table[value >> 1] + (value & 1)
  }
  return table
})()

/** 一张照片的视觉指纹：pHash + 4×4 RGB 颜色网格 */
export interface PhotoSignature {
  /** 16 位十六进制 pHash */
  hash: string
  /** 4×4 网格的 RGB 平均值，共 48 个 0–255 整数 */
  color: number[]
}

/** 计算指纹；解码失败会抛出异常，由调用方决定是否忽略 */
export async function computeSignature(input: string | Buffer): Promise<PhotoSignature> {
  // 一次解码同时得到 pHash 与颜色网格，避免为颜色再读一遍原图
  const { data, info } = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize(HASH_SIZE, HASH_SIZE, { fit: 'fill' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true })

  const pixelCount = HASH_SIZE * HASH_SIZE
  const channels = info.channels
  if (data.length < pixelCount * Math.min(channels, 3)) {
    throw new Error('图像尺寸不足，无法计算指纹')
  }

  const luma = new Uint8Array(pixelCount)
  const colorSums = new Float64Array(COLOR_VALUE_COUNT)

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * channels
    const r = data[offset]
    const g = channels >= 3 ? data[offset + 1] : r
    const b = channels >= 3 ? data[offset + 2] : r
    luma[index] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)

    const x = index % HASH_SIZE
    const y = (index / HASH_SIZE) | 0
    const block =
      ((y / COLOR_BLOCK_SIZE) | 0) * COLOR_GRID_SIZE + ((x / COLOR_BLOCK_SIZE) | 0)
    colorSums[block * 3] += r
    colorSums[block * 3 + 1] += g
    colorSums[block * 3 + 2] += b
  }

  const pixelsPerBlock = COLOR_BLOCK_SIZE * COLOR_BLOCK_SIZE
  const color = new Array<number>(COLOR_VALUE_COUNT)
  for (let index = 0; index < COLOR_VALUE_COUNT; index += 1) {
    color[index] = Math.round(colorSums[index] / pixelsPerBlock)
  }

  return { hash: hashPixels(luma), color }
}

/** 兼容旧调用：只取 pHash */
export async function computePHash(input: string | Buffer): Promise<string> {
  return (await computeSignature(input)).hash
}

/** 纯函数：32×32 灰度像素 -> pHash */
export function hashPixels(pixels: Uint8Array): string {
  // 先按行做一维 DCT，再按列做一次；只需要前 8 个频率
  const rows = new Float64Array(HASH_SIZE * DCT_SIZE)
  for (let y = 0; y < HASH_SIZE; y += 1) {
    const rowOffset = y * HASH_SIZE
    for (let u = 0; u < DCT_SIZE; u += 1) {
      let sum = 0
      const cosOffset = u * HASH_SIZE
      for (let x = 0; x < HASH_SIZE; x += 1) {
        sum += pixels[rowOffset + x] * DCT_COS[cosOffset + x]
      }
      rows[y * DCT_SIZE + u] = sum
    }
  }

  const coefficients = new Float64Array(DCT_SIZE * DCT_SIZE)
  for (let v = 0; v < DCT_SIZE; v += 1) {
    const cosOffset = v * HASH_SIZE
    for (let u = 0; u < DCT_SIZE; u += 1) {
      let sum = 0
      for (let y = 0; y < HASH_SIZE; y += 1) {
        sum += rows[y * DCT_SIZE + u] * DCT_COS[cosOffset + y]
      }
      coefficients[v * DCT_SIZE + u] = sum
    }
  }

  const sorted = Array.from(coefficients).sort((a, b) => a - b)
  const median = (sorted[31] + sorted[32]) / 2

  let hash = ''
  for (let i = 0; i < coefficients.length; i += 4) {
    let nibble = 0
    for (let bit = 0; bit < 4; bit += 1) {
      nibble = (nibble << 1) | (coefficients[i + bit] > median ? 1 : 0)
    }
    hash += nibble.toString(16)
  }
  return hash
}

/** 两个 16 位十六进制 pHash 的汉明距离 */
export function hammingDistance(a: string, b: string): number {
  const aHi = Number.parseInt(a.slice(0, 8), 16) >>> 0
  const bHi = Number.parseInt(b.slice(0, 8), 16) >>> 0
  const aLo = Number.parseInt(a.slice(8, 16), 16) >>> 0
  const bLo = Number.parseInt(b.slice(8, 16), 16) >>> 0
  return popcount(aHi ^ bHi) + popcount(aLo ^ bLo)
}

/** 颜色签名距离：逐格 RGB 绝对差的平均值（0–255） */
export function colorDistance(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length)
  if (length < 3) return 0

  let total = 0
  for (let index = 0; index + 2 < length; index += 3) {
    total +=
      Math.abs(a[index] - b[index]) +
      Math.abs(a[index + 1] - b[index + 1]) +
      Math.abs(a[index + 2] - b[index + 2])
  }
  return total / (length / 3) / 3
}

function popcount(value: number): number {
  return POPCOUNT[value & 0xffff] + POPCOUNT[(value >>> 16) & 0xffff]
}

interface HashNode {
  id: string
  hi: number
  lo: number
  color: number[]
}

function toNode(id: string, signature: PhotoSignature): HashNode {
  return {
    id,
    hi: Number.parseInt(signature.hash.slice(0, 8), 16) >>> 0,
    lo: Number.parseInt(signature.hash.slice(8, 16), 16) >>> 0,
    color: signature.color
  }
}

function distanceBetween(a: HashNode, b: HashNode): number {
  return popcount(a.hi ^ b.hi) + popcount(a.lo ^ b.lo)
}

export interface SimilarClusterOptions {
  /** 至少和组内一张照片的 pHash 距离不超过它 */
  threshold?: number
  /** 和组内所有照片的 pHash 距离上限 */
  diameter?: number
  /** 和组内所有照片的颜色距离上限 */
  colorThreshold?: number
}

/**
 * 增量版近似 complete-link + 颜色门控聚类。
 *
 * 照片可以按任意顺序加入，已有组只会增长，不会被后续照片拆开，适合边看边分析。
 * 新照片仍需满足：与组内至少一张 pHash ≤ threshold，与组内所有成员 pHash ≤ diameter
 * 且颜色 ≤ colorThreshold，避免 A≈B、B≈C 通过链式关系把 A/C 并进同组。
 * 分析完成后由 mergeSimilarGroups 再做一次组级合并，处理同一段连拍被拆成多个子组的情况。
 */
export class IncrementalSimilarCluster {
  private readonly nodes: HashNode[] = []
  private readonly groups: number[][] = []
  private readonly threshold: number
  private readonly maxDistance: number
  private readonly colorThreshold: number

  constructor(options: SimilarClusterOptions = {}) {
    this.threshold = options.threshold ?? SIMILAR_THRESHOLD
    this.maxDistance = options.diameter ?? this.threshold + SIMILAR_DIAMETER_SLACK
    this.colorThreshold = options.colorThreshold ?? SIMILAR_COLOR_THRESHOLD
  }

  add(id: string, signature: PhotoSignature): void {
    const node = toNode(id, signature)
    const index = this.nodes.length
    this.nodes.push(node)

    let bestGroup = -1
    let bestMax = Number.POSITIVE_INFINITY
    let bestMin = Number.POSITIVE_INFINITY

    for (let groupIndex = 0; groupIndex < this.groups.length; groupIndex += 1) {
      const members = this.groups[groupIndex]
      let maxDistanceInGroup = 0
      let minDistanceInGroup = Number.POSITIVE_INFINITY
      let compatible = true

      for (const member of members) {
        const other = this.nodes[member]
        const distance = distanceBetween(node, other)
        if (
          distance > this.maxDistance ||
          colorDistance(node.color, other.color) > this.colorThreshold
        ) {
          compatible = false
          break
        }
        if (distance > maxDistanceInGroup) maxDistanceInGroup = distance
        if (distance < minDistanceInGroup) minDistanceInGroup = distance
      }

      if (!compatible || minDistanceInGroup > this.threshold) continue
      if (
        maxDistanceInGroup < bestMax ||
        (maxDistanceInGroup === bestMax && minDistanceInGroup < bestMin)
      ) {
        bestGroup = groupIndex
        bestMax = maxDistanceInGroup
        bestMin = minDistanceInGroup
      }
    }

    if (bestGroup >= 0) this.groups[bestGroup].push(index)
    else this.groups.push([index])
  }

  /** 成员顺序为加入顺序；默认只返回至少两张照片的组 */
  getGroups(includeSingletons = false): SimilarGroup[] {
    return this.groups
      .filter((members) => includeSingletons || members.length >= 2)
      .map((members) => ({ photoIds: members.map((index) => this.nodes[index].id) }))
  }
}

/**
 * 纯函数：按输入顺序聚类，返回至少两张照片的组。
 * 与增量版使用同一套判定，输入顺序决定输出顺序与组内顺序。
 */
export function clusterSignatures(
  orderedIds: string[],
  signatures: ReadonlyMap<string, PhotoSignature>,
  options: SimilarClusterOptions = {}
): SimilarGroup[] {
  const cluster = new IncrementalSimilarCluster(options)

  for (const id of orderedIds) {
    const signature = signatures.get(id)
    if (signature) cluster.add(id, signature)
  }

  return cluster.getGroups()
}

export interface SimilarMergeOptions {
  /** 两个组之间 pHash 距离的中位数上限 */
  hashThreshold?: number
  /** 颜色距离上限 */
  colorThreshold?: number
  /** 跨组照片对中同时满足 pHash 与颜色阈值的比例下限 */
  colorFraction?: number
  /** 两个组最近照片的时间差上限 */
  timeGapMs?: number
  /** 合并后整组的时间跨度上限，防止通过中间组链式跨越不同拍摄日 */
  timeSpanMs?: number
  /** 合并后采样 pHash 的 p95 上限 */
  diameterP95?: number
  /** 合并后采样 pHash 的最大值上限 */
  diameterMax?: number
  /** 计算跨组统计时每组的抽样张数 */
  sampleSize?: number
  /** 预筛时每组的抽样张数 */
  prefilterSampleSize?: number
}

const MERGE_DEFAULTS: Required<SimilarMergeOptions> = {
  hashThreshold: 20,
  colorThreshold: 30,
  colorFraction: 0.5,
  timeGapMs: 5 * 60 * 1000,
  timeSpanMs: 30 * 60 * 1000,
  diameterP95: 26,
  diameterMax: 32,
  sampleSize: 24,
  prefilterSampleSize: 4
}

interface MergeNode extends HashNode {
  time: number
}

/** 等距抽样；输入为空时返回空数组 */
function sampleEven<T>(items: readonly T[], limit: number): T[] {
  if (items.length <= limit) return [...items]
  const result: T[] = []
  for (let index = 0; index < limit; index += 1) {
    result.push(items[Math.round((index * (items.length - 1)) / (limit - 1))])
  }
  return result
}

/** 两个组最近成员的时间差；两组的时间都已按升序排列 */
function minTimeGap(a: readonly number[], b: readonly number[]): number {
  let i = 0
  let j = 0
  let best = Number.POSITIVE_INFINITY
  while (i < a.length && j < b.length) {
    const distance = Math.abs(a[i] - b[j])
    if (distance < best) best = distance
    if (a[i] < b[j]) i += 1
    else j += 1
  }
  return best
}

/**
 * 分析完成后的组级合并。
 *
 * 增量聚类按"先到先得"分配照片，同一段连拍常被拆成相邻的几个子组；
 * 这里用组间中位数 + 颜色比例 + 时间护栏做二次合并。只应在整本相册分析完成后调用，
 * 不参与渐进快照，避免分析过程中组反复变化。
 *
 * 返回的组包含单张照片的组，由调用方决定是否过滤。
 */
export function mergeSimilarGroups(
  groups: SimilarGroup[],
  signatures: ReadonlyMap<string, PhotoSignature>,
  times: ReadonlyMap<string, number>,
  options: SimilarMergeOptions = {}
): SimilarGroup[] {
  const config = { ...MERGE_DEFAULTS, ...options }
  const nodeById = new Map<string, MergeNode>()

  const getNode = (id: string): MergeNode | null => {
    const existing = nodeById.get(id)
    if (existing) return existing
    const signature = signatures.get(id)
    const time = times.get(id)
    if (!signature || time === undefined) return null
    const node: MergeNode = { ...toNode(id, signature), time }
    nodeById.set(id, node)
    return node
  }

  let current = groups
    .map((group) => group.photoIds.filter((id) => getNode(id) !== null))
    .filter((ids) => ids.length > 0)

  if (current.length < 2) return current.map((photoIds) => ({ photoIds }))

  // 组的时间信息每轮重建一次，供时间护栏与抽样的最小时间差使用
  let timeLists: number[][] = []
  let timeRanges: Array<{ min: number; max: number }> = []
  const refreshTimes = (): void => {
    timeLists = current.map((ids) => ids.map((id) => nodeById.get(id)!.time).sort((a, b) => a - b))
    timeRanges = timeLists.map((list) => ({ min: list[0], max: list[list.length - 1] }))
  }
  refreshTimes()

  const shouldMerge = (a: number, b: number): boolean => {
    if (minTimeGap(timeLists[a], timeLists[b]) > config.timeGapMs) return false
    if (
      Math.max(timeRanges[a].max, timeRanges[b].max) -
        Math.min(timeRanges[a].min, timeRanges[b].min) >
      config.timeSpanMs
    ) {
      return false
    }

    const groupA = current[a]
    const groupB = current[b]

    const preA = sampleEven(groupA, config.prefilterSampleSize).map((id) => nodeById.get(id)!)
    const preB = sampleEven(groupB, config.prefilterSampleSize).map((id) => nodeById.get(id)!)
    let prefilterMin = Number.POSITIVE_INFINITY
    for (const left of preA) {
      for (const right of preB) {
        prefilterMin = Math.min(prefilterMin, distanceBetween(left, right))
      }
    }
    if (prefilterMin > config.hashThreshold) return false

    const sampleA = sampleEven(groupA, config.sampleSize).map((id) => nodeById.get(id)!)
    const sampleB = sampleEven(groupB, config.sampleSize).map((id) => nodeById.get(id)!)
    const distances: number[] = []
    let colorPass = 0
    for (const left of sampleA) {
      for (const right of sampleB) {
        const distance = distanceBetween(left, right)
        distances.push(distance)
        if (
          distance <= config.hashThreshold &&
          colorDistance(left.color, right.color) <= config.colorThreshold
        ) {
          colorPass += 1
        }
      }
    }
    distances.sort((x, y) => x - y)
    if (distances[Math.floor(distances.length / 2)] > config.hashThreshold) return false
    if (colorPass / distances.length < config.colorFraction) return false

    // 合并后的整体直径护栏：防止 A≈B、B≈C 把 A/C 并进同一组
    const unionSample = sampleEven(
      [...groupA, ...groupB],
      config.sampleSize
    ).map((id) => nodeById.get(id)!)
    const unionDistances: number[] = []
    for (let left = 0; left < unionSample.length; left += 1) {
      for (let right = left + 1; right < unionSample.length; right += 1) {
        unionDistances.push(distanceBetween(unionSample[left], unionSample[right]))
      }
    }
    unionDistances.sort((x, y) => x - y)
    if (unionDistances[Math.floor(unionDistances.length * 0.95)] > config.diameterP95) {
      return false
    }
    return unionDistances[unionDistances.length - 1] <= config.diameterMax
  }

  for (let round = 0; round < 6; round += 1) {
    const parent = Int32Array.from({ length: current.length }, (_, index) => index)
    const find = (index: number): number => {
      let root = index
      while (parent[root] !== root) root = parent[root]
      while (parent[index] !== index) {
        const next = parent[index]
        parent[index] = root
        index = next
      }
      return root
    }
    const union = (a: number, b: number): boolean => {
      const rootA = find(a)
      const rootB = find(b)
      if (rootA === rootB) return false
      parent[rootB] = rootA
      return true
    }

    let changed = false
    for (let a = 0; a < current.length; a += 1) {
      for (let b = a + 1; b < current.length; b += 1) {
        if (find(a) === find(b)) continue
        if (current[a].length === 1 && current[b].length === 1) continue
        if (!shouldMerge(a, b)) continue
        union(a, b)
        changed = true
      }
    }

    if (!changed) break

    const merged = new Map<number, string[]>()
    for (let index = 0; index < current.length; index += 1) {
      const root = find(index)
      const target = merged.get(root)
      if (target) target.push(...current[index])
      else merged.set(root, [...current[index]])
    }
    current = [...merged.values()]
    refreshTimes()
  }

  return current.map((photoIds) => ({ photoIds }))
}
