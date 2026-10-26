import sharp from 'sharp'
import type { SimilarGroup } from '../shared/types'

// 与缩略图生成保持一致：并发由调用方的任务数控制，sharp 内部不再按 CPU 核数叠加
sharp.concurrency(1)

/** 感知哈希使用 32×32 灰度图，取 DCT 左上角 8×8 低频系数组成 64 bit */
const HASH_SIZE = 32
const DCT_SIZE = 8

/** 汉明距离阈值：越小越严格。12 能覆盖曝光/压缩/轻微裁切，同时避免把不同场景误合并 */
export const SIMILAR_THRESHOLD = 12
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

/** 计算 pHash（16 位十六进制字符串）；解码失败会抛出异常，由调用方决定是否忽略 */
export async function computePHash(input: string | Buffer): Promise<string> {
  const { data } = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize(HASH_SIZE, HASH_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  if (data.length < HASH_SIZE * HASH_SIZE) {
    throw new Error('图像尺寸不足，无法计算指纹')
  }
  return hashPixels(data)
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

function popcount(value: number): number {
  return POPCOUNT[value & 0xffff] + POPCOUNT[(value >>> 16) & 0xffff]
}

interface HashNode {
  id: string
  hi: number
  lo: number
}

function distanceBetween(a: HashNode, b: HashNode): number {
  return popcount(a.hi ^ b.hi) + popcount(a.lo ^ b.lo)
}

/**
 * 增量版近似 complete-link 聚类。
 *
 * 照片可以按任意顺序加入，已有组只会增长，不会被后续照片拆开，适合边看边分析。
 * 新照片仍需满足：与组内至少一张 ≤ threshold，且与组内所有成员 ≤ threshold + slack，
 * 避免 A≈B、B≈C 通过链式关系把 A/C 并进同组。
 */
export class IncrementalSimilarCluster {
  private readonly nodes: HashNode[] = []
  private readonly groups: number[][] = []
  private readonly threshold: number
  private readonly maxDistance: number

  constructor(threshold = SIMILAR_THRESHOLD) {
    this.threshold = threshold
    this.maxDistance = threshold + SIMILAR_DIAMETER_SLACK
  }

  add(id: string, hash: string): void {
    const node: HashNode = {
      id,
      hi: Number.parseInt(hash.slice(0, 8), 16) >>> 0,
      lo: Number.parseInt(hash.slice(8, 16), 16) >>> 0
    }
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
        const distance = distanceBetween(node, this.nodes[member])
        if (distance > this.maxDistance) {
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

  /** 只返回至少两张照片的组；成员顺序为加入顺序 */
  getGroups(): SimilarGroup[] {
    return this.groups
      .filter((members) => members.length >= 2)
      .map((members) => ({ photoIds: members.map((index) => this.nodes[index].id) }))
  }
}

/**
 * 纯函数：按输入顺序聚类，返回至少两张照片的组。
 * 与增量版使用同一套判定，输入顺序决定输出顺序与组内顺序。
 */
export function clusterHashes(
  orderedIds: string[],
  hashes: ReadonlyMap<string, string>,
  threshold = SIMILAR_THRESHOLD
): SimilarGroup[] {
  const cluster = new IncrementalSimilarCluster(threshold)

  for (const id of orderedIds) {
    const hash = hashes.get(id)
    if (hash) cluster.add(id, hash)
  }

  return cluster.getGroups()
}
