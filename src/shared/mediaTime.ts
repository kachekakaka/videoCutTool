import { MediaTime } from './types';

export function rational(numerator: bigint, denominator: bigint): MediaTime {
  if (denominator <= 0n) throw new Error('无效的媒体时间基');
  return { numerator: numerator.toString(), denominator: denominator.toString() };
}
export function secondsTime(value: string): MediaTime {
  if (!/^[+-]?\d+(\.\d+)?$/.test(value)) throw new Error('无效的媒体起始时间');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole) * denominator + BigInt(fraction || '0');
  return rational(negative ? -numerator : numerator, denominator);
}
export function frameTime(ticks: string | number, timeBase: string, origin: MediaTime): MediaTime {
  const [num, den] = timeBase.split('/').map(BigInt);
  const originDen = BigInt(origin.denominator);
  return rational(BigInt(ticks) * num * originDen - BigInt(origin.numerator) * den, den * originDen);
}
export function compareTime(a: MediaTime, b: MediaTime): number {
  const difference = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function addTime(a: MediaTime, b: MediaTime): MediaTime {
  return rational(BigInt(a.numerator) * BigInt(b.denominator) + BigInt(b.numerator) * BigInt(a.denominator), BigInt(a.denominator) * BigInt(b.denominator));
}
export function subtractTime(a: MediaTime, b: MediaTime): MediaTime {
  return addTime(a, { ...b, numerator: (-BigInt(b.numerator)).toString() });
}
export function timeMs(time: MediaTime): number { return Number(time.numerator) / Number(time.denominator) * 1000; }
export function millisecondsTime(ms: number): MediaTime { return rational(BigInt(Math.round(ms * 1000)), 1000000n); }
export function ceilMicroseconds(time: MediaTime): bigint {
  const num = BigInt(time.numerator) * 1000000n, den = BigInt(time.denominator);
  return num >= 0n ? (num + den - 1n) / den : num / den;
}
export function formatMicroseconds(us: bigint): string {
  const sign = us < 0n ? '-' : '', absolute = us < 0n ? -us : us;
  return `${sign}${absolute / 1000000n}.${String(absolute % 1000000n).padStart(6, '0')}`;
}
