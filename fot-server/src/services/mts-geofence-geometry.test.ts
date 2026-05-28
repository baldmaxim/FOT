import { describe, it, expect } from 'vitest';
import {
  pointInPolygon,
  distanceToPolygonEdge,
  bboxOfPolygon,
  validatePolygon,
  classifySnapshot,
  getActiveShiftWindow,
  haversineMeters,
  MAX_POLYGON_POINTS,
} from './mts-geofence-geometry.js';
import type { IGeoPoint } from './mts-geofence-geometry.js';
import type { IResolvedSchedule } from '../types/index.js';

// Простой квадрат вокруг Москвы (Кремль): ~1км по стороне.
const KREMLIN_SQUARE: IGeoPoint[] = [
  { lat: 55.7500, lng: 37.6100 },
  { lat: 55.7500, lng: 37.6300 },
  { lat: 55.7600, lng: 37.6300 },
  { lat: 55.7600, lng: 37.6100 },
];

describe('mts-geofence-geometry', () => {
  describe('haversineMeters', () => {
    it('возвращает 0 для одной и той же точки', () => {
      expect(haversineMeters({ lat: 55.75, lng: 37.62 }, { lat: 55.75, lng: 37.62 })).toBeCloseTo(0, 6);
    });
    it('считает ~111км на 1 градус широты', () => {
      const d = haversineMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
      expect(d).toBeGreaterThan(111_000);
      expect(d).toBeLessThan(111_500);
    });
  });

  describe('pointInPolygon', () => {
    it('точка строго внутри квадрата → true', () => {
      expect(pointInPolygon({ lat: 55.7550, lng: 37.6200 }, KREMLIN_SQUARE)).toBe(true);
    });
    it('точка строго снаружи → false', () => {
      expect(pointInPolygon({ lat: 55.7000, lng: 37.6200 }, KREMLIN_SQUARE)).toBe(false);
    });
    it('возвращает false на полигоне с <3 точек', () => {
      expect(pointInPolygon({ lat: 0, lng: 0 }, [])).toBe(false);
      expect(pointInPolygon({ lat: 0, lng: 0 }, [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }])).toBe(false);
    });
    it('работает на L-shape (невыпуклый)', () => {
      const lShape: IGeoPoint[] = [
        { lat: 0, lng: 0 },
        { lat: 0, lng: 10 },
        { lat: 5, lng: 10 },
        { lat: 5, lng: 5 },
        { lat: 10, lng: 5 },
        { lat: 10, lng: 0 },
      ];
      expect(pointInPolygon({ lat: 2, lng: 2 }, lShape)).toBe(true);
      // В вырезе L
      expect(pointInPolygon({ lat: 8, lng: 8 }, lShape)).toBe(false);
    });
  });

  describe('distanceToPolygonEdge', () => {
    it('точка на вершине → 0', () => {
      const d = distanceToPolygonEdge(KREMLIN_SQUARE[0], KREMLIN_SQUARE);
      expect(d).toBeLessThan(1);
    });
    it('расстояние снаружи примерно равно прямому до ближайшего ребра', () => {
      // Севернее верхнего ребра на ~0.001°  ≈ 111 м
      const d = distanceToPolygonEdge({ lat: 55.7610, lng: 37.6200 }, KREMLIN_SQUARE);
      expect(d).toBeGreaterThan(100);
      expect(d).toBeLessThan(120);
    });
  });

  describe('bboxOfPolygon', () => {
    it('считает корректный bbox квадрата', () => {
      const b = bboxOfPolygon(KREMLIN_SQUARE);
      expect(b.minLat).toBe(55.75);
      expect(b.maxLat).toBe(55.76);
      expect(b.minLng).toBe(37.61);
      expect(b.maxLng).toBe(37.63);
    });
  });

  describe('validatePolygon', () => {
    it('принимает валидный квадрат', () => {
      const r = validatePolygon(KREMLIN_SQUARE);
      expect(r.ok).toBe(true);
    });
    it('отвергает < 3 точек', () => {
      const r = validatePolygon([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('too_few_points');
    });
    it('отвергает > MAX_POLYGON_POINTS', () => {
      const big = Array.from({ length: MAX_POLYGON_POINTS + 1 }, (_, i) => ({ lat: i * 0.0001, lng: i * 0.0001 }));
      const r = validatePolygon(big);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('too_many_points');
    });
    it('отвергает невалидные координаты', () => {
      const r = validatePolygon([{ lat: 100, lng: 0 }, { lat: 0, lng: 0 }, { lat: 1, lng: 1 }]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('invalid_coordinate');
    });
    it('отвергает self-intersecting bowtie', () => {
      const bowtie: IGeoPoint[] = [
        { lat: 0, lng: 0 },
        { lat: 1, lng: 1 },
        { lat: 0, lng: 1 },
        { lat: 1, lng: 0 },
      ];
      const r = validatePolygon(bowtie);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('self_intersecting');
    });
    it('отвергает non-array', () => {
      const r = validatePolygon('not an array');
      expect(r.ok).toBe(false);
    });
  });

  describe('classifySnapshot', () => {
    it('accuracy=0: точка внутри → inside', () => {
      const c = classifySnapshot({ lat: 55.7550, lng: 37.6200 }, 0, KREMLIN_SQUARE);
      expect(c).toBe('inside');
    });
    it('accuracy=0: точка снаружи → outside', () => {
      const c = classifySnapshot({ lat: 55.7000, lng: 37.6200 }, 0, KREMLIN_SQUARE);
      expect(c).toBe('outside');
    });
    it('accuracy=500m: точка вне зоны в 100м от края → ambiguous', () => {
      // 0.001 deg lat ≈ 111м севернее верхнего ребра (55.76)
      const c = classifySnapshot({ lat: 55.7610, lng: 37.6200 }, 500, KREMLIN_SQUARE);
      expect(c).toBe('ambiguous');
    });
    it('accuracy=50m: точка вне зоны в 200м от края → outside', () => {
      const c = classifySnapshot({ lat: 55.7620, lng: 37.6200 }, 50, KREMLIN_SQUARE);
      expect(c).toBe('outside');
    });
    it('accuracy=null/undefined трактуется как 0', () => {
      expect(classifySnapshot({ lat: 55.7550, lng: 37.6200 }, null, KREMLIN_SQUARE)).toBe('inside');
      expect(classifySnapshot({ lat: 55.7550, lng: 37.6200 }, undefined, KREMLIN_SQUARE)).toBe('inside');
    });
  });

  describe('getActiveShiftWindow', () => {
    const fakeSchedule = (start: string, end: string, hours = 8): IResolvedSchedule => ({
      schedule_id: 's1',
      schedule_type: 'office',
      work_start: start,
      work_end: end,
      work_hours: hours,
      work_days: [1, 2, 3, 4, 5, 6, 7],
      office_days: null,
      late_threshold_minutes: 0,
      day_overrides: null,
      lunch_minutes: 0,
      respects_holidays: false,
      pattern_type: 'custom',
      expected_saturdays_per_month: 0,
      expected_sundays_per_month: 0,
      full_day_threshold_minutes: null,
      weekend_full_day_threshold_minutes: null,
      cycle_length: null,
      cycle_days: null,
      anchor_date: null,
      assignment_anchor_date: null,
      source: 'employee',
    });

    it('возвращает окно для дневной смены, если now внутри 09:00-18:00', async () => {
      const resolve = async () => fakeSchedule('09:00:00', '18:00:00');
      const getDay = () => ({ work_start: '09:00:00', work_end: '18:00:00', work_hours: 8, lunch_minutes: 0 });
      const now = new Date(2026, 4, 20, 12, 0); // 20 мая 2026, полдень
      const w = await getActiveShiftWindow(1, now, { resolve, getDay });
      expect(w).not.toBeNull();
      expect(w?.origin).toBe('today');
    });

    it('возвращает null если now вне дневной смены', async () => {
      const resolve = async () => fakeSchedule('09:00:00', '18:00:00');
      const getDay = () => ({ work_start: '09:00:00', work_end: '18:00:00', work_hours: 8, lunch_minutes: 0 });
      const now = new Date(2026, 4, 20, 22, 0);
      const w = await getActiveShiftWindow(1, now, { resolve, getDay });
      expect(w).toBeNull();
    });

    it('кросс-полуночная смена: в 02:00 возвращает окно вчерашнего дня 22:00→06:00', async () => {
      const resolve = async () => fakeSchedule('22:00:00', '06:00:00');
      const getDay = () => ({ work_start: '22:00:00', work_end: '06:00:00', work_hours: 8, lunch_minutes: 0 });
      const now = new Date(2026, 4, 21, 2, 0); // 02:00 21 мая
      const w = await getActiveShiftWindow(1, now, { resolve, getDay });
      expect(w).not.toBeNull();
      expect(w?.origin).toBe('previous-day-night');
    });

    it('возвращает null при work_hours <= 0 (выходной)', async () => {
      const resolve = async () => fakeSchedule('09:00:00', '18:00:00', 0);
      const getDay = () => ({ work_start: '09:00:00', work_end: '18:00:00', work_hours: 0, lunch_minutes: 0 });
      const now = new Date(2026, 4, 23, 12, 0);
      const w = await getActiveShiftWindow(1, now, { resolve, getDay });
      expect(w).toBeNull();
    });
  });
});
