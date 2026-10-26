/**
 * 多层浮层共用一把页面滚动锁。
 * 用计数而不是各自保存/恢复，避免细看层和观赏窗口交替关闭时提前解锁。
 */
let lockCount = 0
let previousOverflow = ''

/** 调用后返回释放函数；重复调用释放函数不会重复计数 */
export function lockPageScroll(): () => void {
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  lockCount += 1

  let released = false
  return () => {
    if (released) return
    released = true
    lockCount -= 1
    if (lockCount === 0) document.body.style.overflow = previousOverflow
  }
}
