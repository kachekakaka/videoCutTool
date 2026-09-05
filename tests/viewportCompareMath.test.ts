import { describe, it, expect } from 'vitest';
import {
  clampSplitPercent,
  calculateSplitPercentFromEvent,
  clampPanOffset,
} from '../src/shared/viewportCompareMath';

describe('viewportCompareMath', () => {
  describe('clampSplitPercent', () => {
    it('应将卷帘分割百分比严格限制在安全视口范围内', () => {
      expect(clampSplitPercent(-10)).toBe(2);
      expect(clampSplitPercent(0)).toBe(2);
      expect(clampSplitPercent(50)).toBe(50);
      expect(clampSplitPercent(100)).toBe(98);
      expect(clampSplitPercent(120)).toBe(98);
    });
  });

  describe('calculateSplitPercentFromEvent', () => {
    it('应准确计算视口坐标系下的鼠标分割百分比并完成限位', () => {
      const containerRect = { left: 100, width: 800 };
      // 位于中心点 (100 + 400 = 500)
      expect(calculateSplitPercentFromEvent(500, containerRect)).toBe(50);
      // 位于左边缘外 (50 < 100)
      expect(calculateSplitPercentFromEvent(50, containerRect)).toBe(2);
      // 位于右边缘外 (1000 > 900)
      expect(calculateSplitPercentFromEvent(1000, containerRect)).toBe(98);
    });
  });

  describe('clampPanOffset', () => {
    it('当缩放倍率为 1 时平移偏移量应始终归零', () => {
      const offset = clampPanOffset({ x: 100, y: -50 }, 1, { width: 800, height: 450 });
      expect(offset).toEqual({ x: 0, y: 0 });
    });

    it('当缩放倍率大于 1 时应将平移偏移量限制在有效画框范围内防止画面拖飞', () => {
      // 2x 缩放时，画框最大可平移边界为 width * (zoom - 1) / 2 = 800 * 0.5 = 400
      const offset = clampPanOffset({ x: 600, y: -600 }, 2, { width: 800, height: 400 });
      expect(offset.x).toBeLessThanOrEqual(400);
      expect(offset.x).toBeGreaterThanOrEqual(-400);
      expect(offset.y).toBeLessThanOrEqual(200);
      expect(offset.y).toBeGreaterThanOrEqual(-200);
    });
  });
});
