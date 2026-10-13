/**
 * «Дорога»: поиск решений, стёртых пересборкой сегментов после смены типа зоны.
 *
 * Решение «одобрено/отклонено» привязано к ключу сегмента (сотрудник, дата, выход, вход, точки).
 * Когда точка стала внешней, сегменты пересобрались с другими ключами, и решение пропало без следа:
 * аудита у «Дороги» нет. Косвенный след — официальная версия табеля: одобренный сегмент
 * засчитывался по факту, поэтому часы в версии выше расчёта «как было» ровно на превышение нормы.
 *
 * Вызывать при сценарии «точка внутренняя».
 */
import type { IScenarioSnapshot } from './zone-scenario.js';

export interface ITravelLossRow {
  employeeId: number;
  date: string;
  from: string;
  to: string;
  exitTime: string;
  entryTime: string;
  actualMinutes: number;
  creditedMinutes: number;
  delayMinutes: number;
  /** Часы дня в официальной версии; null — день не входит ни в одну утверждённую подачу. */
  versionHours: number | null;
  approvalId: number | null;
  beforeHours: number;
  verdict: 'одобрение потеряно' | 'решения не было' | 'нет версии' | 'неясно';
}

interface ISegment {
  employee_id: number;
  work_date: string;
  from_access_point_name: string | null;
  to_access_point_name: string | null;
  exit_time: string;
  entry_time: string;
  actual_minutes: number;
  credited_minutes: number;
  delay_minutes: number;
  status: string;
}

const keyOf = (segment: Pick<ISegment, 'employee_id' | 'work_date' | 'exit_time' | 'entry_time' | 'from_access_point_name' | 'to_access_point_name'>): string =>
  [Number(segment.employee_id), String(segment.work_date).slice(0, 10), String(segment.exit_time).slice(0, 8),
    String(segment.entry_time).slice(0, 8), segment.from_access_point_name ?? '', segment.to_access_point_name ?? ''].join('|');

export const findLostTravelDecisions = async (params: {
  snapshot: IScenarioSnapshot;
  employeeIds: number[];
  months: string[];
  from: string;
  to: string;
  versionDay: Map<string, { hours: number; approvalId: number }>;
  beforeHours: (key: string) => number;
}): Promise<ITravelLossRow[]> => {
  const { snapshot, employeeIds, months, from, to, versionDay, beforeHours } = params;
  const { calculateAndSyncTravelSegments } = await import('../../src/services/skud-travel.service.js');

  const stored = new Set((await snapshot.raw<ISegment>(
    `SELECT employee_id, work_date::text AS work_date, exit_time::text AS exit_time, entry_time::text AS entry_time,
            from_access_point_name, to_access_point_name
       FROM skud_travel_segments
      WHERE employee_id = ANY($1::bigint[]) AND work_date BETWEEN $2 AND $3`,
    [employeeIds, from, to],
  )).map(keyOf));

  // Сегменты «как было», которых сейчас нет в хранилище и которые требовали решения.
  const missing: ISegment[] = [];
  for (const month of months) {
    const monthStart = `${month}-01`;
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
    const monthEnd = new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);
    const { segments } = await calculateAndSyncTravelSegments({
      employeeIds,
      startDate: monthStart < from ? from : monthStart,
      endDate: monthEnd > to ? to : monthEnd,
      persist: false,
      exec: snapshot.exec,
    });
    for (const segment of segments as ISegment[]) {
      if (segment.status === 'pending' && !stored.has(keyOf(segment))) missing.push(segment);
    }
  }

  const delayByDay = new Map<string, number>();
  for (const segment of missing) {
    const day = `${Number(segment.employee_id)}_${String(segment.work_date).slice(0, 10)}`;
    delayByDay.set(day, (delayByDay.get(day) ?? 0) + segment.delay_minutes);
  }

  return missing.map(segment => {
    const date = String(segment.work_date).slice(0, 10);
    const day = `${Number(segment.employee_id)}_${date}`;
    const version = versionDay.get(day) ?? null;
    const before = beforeHours(day);
    let verdict: ITravelLossRow['verdict'] = 'нет версии';
    if (version) {
      const extraMinutes = Math.round((version.hours - before) * 60);
      if (Math.abs(extraMinutes) <= 1) verdict = 'решения не было';
      // Одобренный сегмент засчитывается по факту: разница = сумма превышений нормы за день.
      else if (Math.abs(extraMinutes - (delayByDay.get(day) ?? 0)) <= 2) verdict = 'одобрение потеряно';
      else verdict = 'неясно';
    }
    return {
      employeeId: Number(segment.employee_id), date,
      from: segment.from_access_point_name ?? '', to: segment.to_access_point_name ?? '',
      exitTime: String(segment.exit_time).slice(0, 8), entryTime: String(segment.entry_time).slice(0, 8),
      actualMinutes: segment.actual_minutes, creditedMinutes: segment.credited_minutes, delayMinutes: segment.delay_minutes,
      versionHours: version?.hours ?? null, approvalId: version?.approvalId ?? null, beforeHours: before, verdict,
    };
  });
};
