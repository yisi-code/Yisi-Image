import type { Directive } from 'vue'

/**
 * 图标按钮的悬浮提示，替代原生 title。
 *
 * 原生 title 由浏览器管理：按下鼠标后提示会被隐藏，直到悬停的提示文字和按下时不同才再出现，
 * 页面无法控制，表现为「点了一个按钮再移到别的按钮上，有时不出提示」。
 * 这里改为自己响应 pointerenter / pointerleave：按下时只隐藏当前提示，移到任何其他按钮都会重新出现；
 * 刚隐藏不久再移到相邻按钮时立即显示，不再等待延迟。
 *
 * 用法：<button v-tooltip="'画笔'" aria-label="画笔">；提示不承担无障碍名称，按钮仍需 aria-label。
 */

type TooltipValue = string | null | undefined

interface TooltipHandle {
  text: string
  /** 在这个元素上按下过鼠标；离开后才允许再次显示 */
  isSuppressed: boolean
  timer: number
  dispose: () => void
}

const SHOW_DELAY_MS = 320
/** 上一条提示刚隐藏（或仍在显示）时，移到下一个按钮立即显示。 */
const WARM_WINDOW_MS = 600
const GAP_PX = 8
const EDGE_PX = 8

const handles = new WeakMap<HTMLElement, TooltipHandle>()
let bubble: HTMLDivElement | null = null
let owner: HTMLElement | null = null
let lastHiddenAt = Number.NEGATIVE_INFINITY
let hasGlobalListeners = false

function getBubble(): HTMLDivElement {
  if (!bubble) {
    bubble = document.createElement('div')
    bubble.className = 'app-tooltip'
    // 按钮自身带 aria-label，提示只做视觉补充，读屏不必重复朗读。
    bubble.setAttribute('aria-hidden', 'true')
    document.body.appendChild(bubble)
  }
  return bubble
}

function place(el: HTMLElement, tip: HTMLDivElement): void {
  const rect = el.getBoundingClientRect()
  const tipRect = tip.getBoundingClientRect()
  const viewportWidth = document.documentElement.clientWidth
  const viewportHeight = document.documentElement.clientHeight
  const above = rect.top - tipRect.height - GAP_PX
  const below = rect.bottom + GAP_PX

  // 屏幕下半部分的控件（如左下角缩放栏）提示朝上，其余朝下；放不下时翻到另一侧。
  let top = rect.top + rect.height / 2 > viewportHeight / 2 ? above : below
  if (top < EDGE_PX) {
    top = below
  } else if (top + tipRect.height > viewportHeight - EDGE_PX) {
    top = above
  }

  const centered = rect.left + rect.width / 2 - tipRect.width / 2
  const left = Math.min(
    viewportWidth - tipRect.width - EDGE_PX,
    Math.max(EDGE_PX, centered),
  )
  tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`
}

function show(el: HTMLElement): void {
  const handle = handles.get(el)
  if (!handle || !handle.text || !el.isConnected) {
    return
  }
  const tip = getBubble()
  tip.textContent = handle.text
  owner = el
  place(el, tip)
  tip.classList.add('is-visible')
}

function hide(): void {
  if (!owner) {
    return
  }
  owner = null
  lastHiddenAt = performance.now()
  bubble?.classList.remove('is-visible')
}

function installGlobalListeners(): void {
  if (hasGlobalListeners) {
    return
  }
  hasGlobalListeners = true
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hide()
    }
  })
  // 滚动或窗口变化后提示会和按钮错位，直接收起。
  window.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
}

function schedule(el: HTMLElement, handle: TooltipHandle): void {
  window.clearTimeout(handle.timer)
  if (handle.isSuppressed || !handle.text) {
    return
  }
  const isWarm = owner !== null || performance.now() - lastHiddenAt < WARM_WINDOW_MS
  if (isWarm) {
    show(el)
    return
  }
  handle.timer = window.setTimeout(() => show(el), SHOW_DELAY_MS)
}

function bind(el: HTMLElement, text: string): TooltipHandle {
  const handle: TooltipHandle = {
    text,
    isSuppressed: false,
    timer: 0,
    dispose: () => undefined,
  }

  const onEnter = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') {
      schedule(el, handle)
    }
  }
  const onLeave = () => {
    window.clearTimeout(handle.timer)
    handle.isSuppressed = false
    if (owner === el) {
      hide()
    }
  }
  const onDown = () => {
    window.clearTimeout(handle.timer)
    handle.isSuppressed = true
    hide()
  }
  const onFocusIn = (event: FocusEvent) => {
    // 只为键盘焦点显示；鼠标点击产生的焦点不重复弹出。
    const target = event.target
    if (target instanceof Element && target.matches(':focus-visible')) {
      window.clearTimeout(handle.timer)
      show(el)
    }
  }
  const onFocusOut = () => {
    if (owner === el) {
      hide()
    }
  }

  el.addEventListener('pointerenter', onEnter)
  el.addEventListener('pointerleave', onLeave)
  el.addEventListener('pointerdown', onDown)
  el.addEventListener('focusin', onFocusIn)
  el.addEventListener('focusout', onFocusOut)
  handle.dispose = () => {
    window.clearTimeout(handle.timer)
    el.removeEventListener('pointerenter', onEnter)
    el.removeEventListener('pointerleave', onLeave)
    el.removeEventListener('pointerdown', onDown)
    el.removeEventListener('focusin', onFocusIn)
    el.removeEventListener('focusout', onFocusOut)
  }
  return handle
}

export const vTooltip: Directive<HTMLElement, TooltipValue> = {
  mounted(el, binding) {
    installGlobalListeners()
    handles.set(el, bind(el, binding.value ?? ''))
  },
  updated(el, binding) {
    const handle = handles.get(el)
    if (!handle) {
      return
    }
    const text = binding.value ?? ''
    if (text === handle.text) {
      return
    }
    handle.text = text
    if (owner === el) {
      if (text) {
        show(el)
      } else {
        hide()
      }
    }
  },
  beforeUnmount(el) {
    handles.get(el)?.dispose()
    handles.delete(el)
    if (owner === el) {
      hide()
    }
  },
}
