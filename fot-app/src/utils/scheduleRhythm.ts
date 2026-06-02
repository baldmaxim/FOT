import type { ICycleDay, PatternType } from '../types/schedule';

/** Минимальный набор полей расписания, нужный для вычисления ритма. */
export interface IRhythmSource {
  pattern_type: PatternType;
  cycle_length: number | null;
  cycle_days: ICycleDay[] | null;
}

/** Краткое описание ритма графика: «5/2», «6/1», «11/3», «11/3 (произв., 4д)». */
export const formatRhythmSummary = (tpl: IRhythmSource): string => {
  if (tpl.pattern_type === 'cycle' && tpl.cycle_length && tpl.cycle_days) {
    const work = tpl.cycle_days.filter(s => s.work_hours > 0).length;
    const off = tpl.cycle_length - work;
    // Префиксная раскладка: первые work — рабочие, остальные — выходные.
    let prefixWork = 0;
    while (prefixWork < tpl.cycle_days.length && tpl.cycle_days[prefixWork].work_hours > 0) prefixWork++;
    const isPrefix = tpl.cycle_days.slice(prefixWork).every(d => d.work_hours <= 0);
    return isPrefix ? `${work}/${off}` : `${work}/${off} (произв., ${tpl.cycle_length}д)`;
  }
  if (tpl.pattern_type === '5+0') return '5/2';
  if (tpl.pattern_type === '5+2') return '5/2 + субботы';
  if (tpl.pattern_type === '6+0') return '6/1';
  return tpl.pattern_type;
};

/** Ритм без скобочного текста: «11/3 (произв., 4д)» → «11/3». */
export const formatRhythmShort = (tpl: IRhythmSource): string =>
  formatRhythmSummary(tpl).replace(/\s*\([^)]*\)/g, '');
