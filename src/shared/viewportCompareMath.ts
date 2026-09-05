/**
 * 视口画质对比与手势逆变换数学不变量工具
 * 提供严格的百分比限位、视口坐标逆计算与平移安全边界防御
 */

/**
 * 将卷帘对比百分比严格限制在可见视口范围内 (默认 2% ~ 98%)
 */
export function clampSplitPercent(percent: number, min = 2, max = 98): number {
  if (isNaN(percent)) return 50;
  return Math.max(min, Math.min(max, percent));
}

/**
 * 基于鼠标 clientX 与视口容器的物理位置计算相对百分比
 */
export function calculateSplitPercentFromEvent(
  clientX: number,
  containerRect: { left: number; width: number }
): number {
  if (!containerRect.width || containerRect.width <= 0) return 50;
  const relativeX = clientX - containerRect.left;
  const percent = (relativeX / containerRect.width) * 100;
  return clampSplitPercent(percent);
}

/**
 * 将平移偏移量限制在有效画框内，防止放大后画面被完全拖离视窗
 */
export function clampPanOffset(
  offset: { x: number; y: number },
  zoom: number,
  containerSize: { width: number; height: number }
): { x: number; y: number } {
  if (zoom <= 1) {
    return { x: 0, y: 0 };
  }

  // 允许平移的最大范围为放大后溢出尺寸的一半再加缓冲
  const maxX = (containerSize.width * (zoom - 1)) / 2;
  const maxY = (containerSize.height * (zoom - 1)) / 2;

  return {
    x: Math.max(-maxX, Math.min(maxX, offset.x)),
    y: Math.max(-maxY, Math.min(maxY, offset.y)),
  };
}
