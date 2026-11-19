import { describe, expect, it } from 'vitest'
import {
  anchorFloatingPosition,
  clampFloatingBox,
  normalizeFloatingPosition,
  resolveFloatingPosition,
} from './floating'

describe('clampFloatingBox', () => {
  it('限制在容器内并保留边距', () => {
    expect(clampFloatingBox({ left: -40, top: 900 }, 200, 40, 800, 600)).toEqual({
      left: 6,
      top: 554,
    })
  })

  it('容器比工具栏还窄时贴住起始边', () => {
    expect(clampFloatingBox({ left: 120, top: 10 }, 300, 40, 200, 600)).toEqual({
      left: 6,
      top: 10,
    })
  })
})

describe('anchorFloatingPosition', () => {
  it('靠左上时记左上距离', () => {
    expect(anchorFloatingPosition({ left: 20, top: 30 }, 200, 40, 800, 600)).toEqual({
      x: 'left',
      y: 'top',
      dx: 20,
      dy: 30,
    })
  })

  it('靠右下时记右下距离', () => {
    expect(anchorFloatingPosition({ left: 560, top: 540 }, 200, 40, 800, 600)).toEqual({
      x: 'right',
      y: 'bottom',
      dx: 40,
      dy: 20,
    })
  })
})

describe('resolveFloatingPosition', () => {
  it('窗口缩小后把距离压回可视区', () => {
    expect(
      resolveFloatingPosition({ x: 'right', y: 'bottom', dx: 700, dy: 20 }, 200, 40, 600, 400),
    ).toEqual({ x: 'right', y: 'bottom', dx: 394, dy: 20 })
  })
})

describe('normalizeFloatingPosition', () => {
  it('合法值取整并保留锚边', () => {
    expect(normalizeFloatingPosition({ x: 'right', y: 'top', dx: 12.6, dy: '8' })).toEqual({
      x: 'right',
      y: 'top',
      dx: 13,
      dy: 8,
    })
  })

  it('非法值返回 null', () => {
    expect(normalizeFloatingPosition(null)).toBeNull()
    expect(normalizeFloatingPosition({ x: 'center', y: 'top', dx: 1, dy: 1 })).toBeNull()
    expect(normalizeFloatingPosition({ x: 'left', y: 'top', dx: 'abc', dy: 1 })).toBeNull()
  })

  it('负数和超大值被限制', () => {
    expect(normalizeFloatingPosition({ x: 'left', y: 'bottom', dx: -5, dy: 99999 })).toEqual({
      x: 'left',
      y: 'bottom',
      dx: 0,
      dy: 10000,
    })
  })
})
