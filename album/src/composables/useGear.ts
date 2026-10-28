import { ref } from 'vue'
import type { GearSnapshot } from '../../shared/types'

/**
 * 设备库快照在页面切换之间保持：再次进入设备库时先显示上次结果，
 * 主进程随后校验缓存并渐进推送。离开设备库时由 App 调用 pause。
 */
const snapshot = ref<GearSnapshot | null>(null)
const error = ref<string | null>(null)

let subscribed = false
let requestSequence = 0

function subscribe(): void {
  if (subscribed) return
  subscribed = true
  window.api.onGearSnapshot((event) => {
    snapshot.value = event
    error.value = null
  })
}

export function useGear() {
  /** 开始或继续扫描；refresh 会忽略已有样本重新读取 */
  async function start(refresh = false): Promise<void> {
    subscribe()
    const request = (requestSequence += 1)
    error.value = null
    // 再次进入时先显示上次快照，但扫描状态要立刻切到进行中
    if (snapshot.value && !snapshot.value.scanning) {
      snapshot.value = { ...snapshot.value, scanning: true }
    }
    try {
      await window.api.startGearScan(refresh)
    } catch (cause) {
      if (request !== requestSequence) return
      console.error(cause)
      error.value = '设备库扫描失败，请稍后重试'
    }
  }

  async function pause(): Promise<void> {
    requestSequence += 1
    try {
      await window.api.pauseGearScan()
    } catch (cause) {
      console.error(cause)
    }
  }

  return { snapshot, error, subscribe, start, pause }
}
