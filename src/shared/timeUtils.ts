/**
 * 统一时间码格式化与逆向解析纯工具模块
 */

export const formatTimecode = (ms: number, showHours = true): string => {
  if (isNaN(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const milliseconds = Math.floor(ms % 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n: number, z = 2) => ('00' + n).slice(-z);
  const padMs = ('000' + milliseconds).slice(-3);

  if (showHours || hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${padMs}`;
  }
  return `${pad(minutes)}:${pad(seconds)}.${padMs}`;
};

/**
 * 解析用户输入的时间码为毫秒数
 * 支持格式：
 * - HH:MM:SS.mmm 或 HH:MM:SS
 * - MM:SS.mmm 或 MM:SS
 * - SS.mmm 或 纯秒数 (例如 12.5 -> 12500)
 */
export const parseTimecodeToMs = (str: string): number | null => {
  if (!str) return null;
  const trimmed = str.trim();
  if (!trimmed) return null;

  // 纯数字或浮点数（秒）
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const sec = parseFloat(trimmed);
    return Math.round(sec * 1000);
  }

  // 时分秒毫秒匹配: [HH:]MM:SS[.mmm]
  const parts = trimmed.split(':');
  if (parts.length === 2) {
    const minutes = parseInt(parts[0], 10);
    const secParts = parts[1].split('.');
    const seconds = parseInt(secParts[0], 10);
    const ms = secParts.length > 1 ? parseInt(secParts[1].padEnd(3, '0').slice(0, 3), 10) : 0;
    if (isNaN(minutes) || isNaN(seconds) || isNaN(ms)) return null;
    return minutes * 60000 + seconds * 1000 + ms;
  } else if (parts.length === 3) {
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1], 10);
    const secParts = parts[2].split('.');
    const seconds = parseInt(secParts[0], 10);
    const ms = secParts.length > 1 ? parseInt(secParts[1].padEnd(3, '0').slice(0, 3), 10) : 0;
    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds) || isNaN(ms)) return null;
    return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
  }

  return null;
};

/**
 * 格式化任务时间戳为 YYYYMMDD_HHmm 格式（例如 20260905_1746）
 */
export const formatTaskTimestamp = (date = new Date()): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${y}${m}${d}_${hh}${mm}`;
};
