/**
 * Чистая геометрия для геозон МТС. Без I/O, без побочных эффектов — это
 * упрощает юнит-тесты и позволяет поллеру держать декриптованные полигоны
 * в памяти и крутить точки-в-полигоне без накладных расходов.
 *
 * Все функции работают в географических координатах WGS84 (lat/lng в градусах).
 * Расстояния — в метрах через формулу гаверсинуса.
 */

import { getScheduleForDate, resolveSchedule } from './schedule.service.js';
import type { IResolvedSchedule } from '../types/index.js';

export interface IGeoPoint {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

/** Гаверсин: расстояние между двумя точками на сфере, в метрах. */
export function haversineMeters(a: IGeoPoint, b: IGeoPoint): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Bounding box полигона. */
export function bboxOfPolygon(ring: IGeoPoint[]): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of ring) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Точка в полигоне (ray casting). Полигон замкнутый по соглашению — последняя
 * точка != первая (замыкается алгоритмом). Кольцо ориентация-агностично.
 */
export function pointInPolygon(p: IGeoPoint, ring: IGeoPoint[]): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].lng, yi = ring[i].lat;
    const xj = ring[j].lng, yj = ring[j].lat;
    const intersect = ((yi > p.lat) !== (yj > p.lat)) &&
      (p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Расстояние от точки до отрезка на сфере (метры).
 * Аппроксимация через локальную проекцию (для метров-километров полигона
 * погрешность <0.5% на средних широтах). Этого хватает для геозон ≤ 50 км.
 */
function distanceToSegmentMeters(p: IGeoPoint, a: IGeoPoint, b: IGeoPoint): number {
  // Локальная экви-плоская проекция вокруг точки a
  const cosLat = Math.cos(a.lat * DEG_TO_RAD);
  const ax = 0;
  const ay = 0;
  const bx = (b.lng - a.lng) * cosLat;
  const by = (b.lat - a.lat);
  const px = (p.lng - a.lng) * cosLat;
  const py = (p.lat - a.lat);

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;

  const projLat = a.lat + t * (b.lat - a.lat);
  const projLng = a.lng + t * (b.lng - a.lng);
  return haversineMeters(p, { lat: projLat, lng: projLng });
}

/** Минимальное расстояние от точки до края полигона (в метрах). */
export function distanceToPolygonEdge(p: IGeoPoint, ring: IGeoPoint[]): number {
  if (ring.length < 2) return Infinity;
  let min = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const d = distanceToSegmentMeters(p, a, b);
    if (d < min) min = d;
  }
  return min;
}

/** Простая проверка пересечения двух отрезков на плоскости. */
function segmentsIntersect(p1: IGeoPoint, p2: IGeoPoint, p3: IGeoPoint, p4: IGeoPoint): boolean {
  const o = (a: IGeoPoint, b: IGeoPoint, c: IGeoPoint): number => {
    const v = (b.lng - a.lng) * (c.lat - a.lat) - (b.lat - a.lat) * (c.lng - a.lng);
    if (Math.abs(v) < 1e-12) return 0;
    return v > 0 ? 1 : -1;
  };
  const o1 = o(p1, p2, p3);
  const o2 = o(p1, p2, p4);
  const o3 = o(p3, p4, p1);
  const o4 = o(p3, p4, p2);
  return o1 !== o2 && o3 !== o4;
}

/**
 * Валидация полигона перед сохранением.
 *  - 3..MAX_POINTS точек
 *  - lat ∈ [-90, 90], lng ∈ [-180, 180], числа конечные
 *  - нет самопересечений (любые два не-соседних ребра)
 */
export const MAX_POLYGON_POINTS = 500;
export const MIN_POLYGON_POINTS = 3;

export type PolygonValidationError =
  | 'too_few_points'
  | 'too_many_points'
  | 'invalid_coordinate'
  | 'self_intersecting';

export function validatePolygon(ring: unknown): { ok: true; ring: IGeoPoint[] } | { ok: false; error: PolygonValidationError } {
  if (!Array.isArray(ring)) return { ok: false, error: 'invalid_coordinate' };
  if (ring.length < MIN_POLYGON_POINTS) return { ok: false, error: 'too_few_points' };
  if (ring.length > MAX_POLYGON_POINTS) return { ok: false, error: 'too_many_points' };
  const points: IGeoPoint[] = [];
  for (const item of ring) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'invalid_coordinate' };
    const lat = Number((item as Record<string, unknown>).lat);
    const lng = Number((item as Record<string, unknown>).lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: 'invalid_coordinate' };
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { ok: false, error: 'invalid_coordinate' };
    points.push({ lat, lng });
  }
  // Самопересечения: O(n²), приемлемо для n ≤ 500.
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return { ok: false, error: 'self_intersecting' };
      }
    }
  }
  return { ok: true, ring: points };
}

/**
 * Классификация снимка по accuracy-радиусу:
 *  - 'outside'  — точка строго вне полигона И ближайшее ребро дальше accuracy (точка
 *    не может быть внутри даже с погрешностью);
 *  - 'inside'   — точка внутри полигона И ближайшее ребро дальше accuracy (точка
 *    не может быть снаружи даже с погрешностью);
 *  - 'ambiguous' — точка возле границы с большой неопределённостью, тик игнорируется
 *    (ни open, ни close нарушения).
 *
 * При accuracy=0 (или null) считаем 'inside'/'outside' по строгому PIP.
 */
export function classifySnapshot(
  point: IGeoPoint,
  accuracyMeters: number | null | undefined,
  ring: IGeoPoint[],
): 'inside' | 'outside' | 'ambiguous' {
  const inside = pointInPolygon(point, ring);
  const acc = Number.isFinite(accuracyMeters) ? Math.max(0, Number(accuracyMeters)) : 0;
  if (acc === 0) return inside ? 'inside' : 'outside';
  const edgeDist = distanceToPolygonEdge(point, ring);
  if (edgeDist <= acc) return 'ambiguous';
  return inside ? 'inside' : 'outside';
}

// ---------- Окно активной смены ----------

export interface IActiveShiftWindow {
  /** Начало активной смены (включительно). */
  startsAt: Date;
  /** Конец активной смены (включительно). */
  endsAt: Date;
  /** Источник окна — сегодняшняя смена или ночная вчерашняя. */
  origin: 'today' | 'previous-day-night';
}

const toIsoDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseHHMM = (value: string): { h: number; m: number } => {
  const [h = 0, m = 0] = value.split(':').map(Number);
  return { h, m };
};

const composeDate = (base: Date, hh: number, mm: number): Date => {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);
  return d;
};

/**
 * Окно активной смены сотрудника на момент `now`. Возвращает null, если
 * сейчас НЕ рабочее время сотрудника.
 *
 * Учитывает кросс-полуночные смены: если у вчерашнего графика work_end < work_start
 * (например 22:00→06:00), окно может тянуться в следующий день. Для now=02:00
 * берём вчерашний график.
 *
 * day_overrides и cycle_days резолвятся через getScheduleForDate.
 */
export async function getActiveShiftWindow(
  employeeId: number,
  now: Date = new Date(),
  deps: { resolve?: typeof resolveSchedule; getDay?: typeof getScheduleForDate } = {},
): Promise<IActiveShiftWindow | null> {
  const resolve = deps.resolve ?? resolveSchedule;
  const getDay = deps.getDay ?? getScheduleForDate;

  const consider = async (anchor: Date, label: 'today' | 'previous-day-night'): Promise<IActiveShiftWindow | null> => {
    const schedule = await resolve(employeeId, null, toIsoDate(anchor));
    if (!schedule) return null;
    const dayParams = getDay(schedule as IResolvedSchedule, anchor);
    if (!dayParams || !dayParams.work_start || !dayParams.work_end) return null;
    // work_hours=0 на этот день — выходной/неработающий слот.
    if (dayParams.work_hours <= 0) return null;
    const start = parseHHMM(dayParams.work_start);
    const end = parseHHMM(dayParams.work_end);
    const startsAt = composeDate(anchor, start.h, start.m);
    let endsAt = composeDate(anchor, end.h, end.m);
    if (endsAt <= startsAt) {
      // Ночная смена → переносим конец на следующий день.
      endsAt = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
    }
    if (now >= startsAt && now <= endsAt) {
      return { startsAt, endsAt, origin: label };
    }
    return null;
  };

  // 1. Окно «вчера» (для ночных смен, у которых конец заходит в сегодня).
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const yest = await consider(yesterday, 'previous-day-night');
  if (yest) return yest;

  // 2. Сегодняшнее окно.
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return consider(today, 'today');
}
