import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  addMonthsIso,
  computeOtStatus,
  otTrainingDef,
  otTrainingsFor,
  summarizeOtPerson,
  OT_TRAININGS,
  OT_WARN_DAYS,
  type IOtTrainingDef,
} from './ot-training.service.js';

const def = (kind: string): IOtTrainingDef => {
  const found = otTrainingDef(kind);
  if (!found) throw new Error(`Нет вида обучения ${kind}`);
  return found;
};

const TODAY = '2026-07-27';

describe('addMonthsIso', () => {
  it('обычный сдвиг вперёд', () => {
    expect(addMonthsIso('2026-07-27', 3)).toBe('2026-10-27');
  });

  it('кламп конца месяца: 31.01 + 1 месяц = 28.02', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28');
  });

  it('високосный год: 31.01.2028 + 1 месяц = 29.02', () => {
    expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('переход через год', () => {
    expect(addMonthsIso('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('три года (периодичность программ)', () => {
    expect(addMonthsIso('2026-02-29'.replace('2026', '2024'), 36)).toBe('2027-02-28');
    expect(addMonthsIso('2026-07-01', 36)).toBe('2029-07-01');
  });

  it('некорректная дата — исключение, а не тихий сдвиг', () => {
    expect(() => addMonthsIso('27.07.2026', 1)).toThrow();
  });
});

describe('computeOtStatus', () => {
  it('нет даты — missing, без даты окончания', () => {
    expect(computeOtStatus(def('workplace'), null, TODAY)).toEqual({
      kind: 'workplace', passed_on: null, valid_until: null, status: 'missing',
    });
  });

  it('бессрочный вид — valid без даты окончания', () => {
    expect(computeOtStatus(def('introductory'), '2020-01-01', TODAY)).toEqual({
      kind: 'introductory', passed_on: '2020-01-01', valid_until: null, status: 'valid',
    });
  });

  it('инструктаж на рабочем месте 4 месяца назад — просрочен', () => {
    const state = computeOtStatus(def('workplace'), '2026-03-27', TODAY);
    expect(state.valid_until).toBe('2026-06-27');
    expect(state.status).toBe('expired');
  });

  it('истёк вчера — expired', () => {
    // 3 месяца от 2026-04-26 → 2026-07-26, вчера относительно TODAY.
    expect(computeOtStatus(def('workplace'), '2026-04-26', TODAY).status).toBe('expired');
  });

  it('истекает сегодня — ещё expiring, не expired', () => {
    expect(computeOtStatus(def('workplace'), '2026-04-27', TODAY).status).toBe('expiring');
  });

  it('ровно OT_WARN_DAYS до конца — expiring, днём раньше — valid', () => {
    const warnBoundary = addMonthsIso(TODAY, 0); // читаемость: считаем от TODAY
    expect(warnBoundary).toBe(TODAY);
    // Дата окончания = TODAY + 30 дней → passed_on = окончание − 3 месяца.
    expect(computeOtStatus(def('workplace'), '2026-05-26', TODAY).status).toBe('expiring'); // до 26.08 = 30 дн
    expect(computeOtStatus(def('workplace'), '2026-05-28', TODAY).status).toBe('valid');    // до 28.08 = 32 дн
  });

  it('порог вынесен константой', () => {
    expect(OT_WARN_DAYS).toBe(30);
  });
});

describe('каталог видов обучения', () => {
  it('коды и порядок уникальны', () => {
    const kinds = OT_TRAININGS.map(t => t.kind);
    const orders = OT_TRAININGS.map(t => t.order);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it('подрядчикам остаётся только вводный инструктаж', () => {
    expect(otTrainingsFor('contractor').map(t => t.kind)).toEqual(['introductory']);
    expect(OT_TRAININGS.filter(t => t.audience === 'all').map(t => t.kind)).toEqual(['introductory']);
  });

  it('весь цикл обучения — у своих сотрудников', () => {
    const kinds = otTrainingsFor('employee').map(t => t.kind);
    expect(kinds).toContain('program_a');
    expect(kinds).toContain('cross_profession');
    expect(kinds).toHaveLength(OT_TRAININGS.length);
  });

  it('программа А стоит между протоколом ОТ и программой Б, без оговорки про ИТР', () => {
    expect(def('program_a').order).toBeGreaterThan(def('protocol').order);
    expect(def('program_a').order).toBeLessThan(def('program_b').order);
    expect(def('program_a').label).toBe(
      'Программа А — обучение по общим вопросам охраны труда и функционирования СУОТ',
    );
    // Признака ИТР у сотрудника нет — подсказка не должна обещать фильтрацию.
    expect(def('program_a').hint).not.toMatch(/ИТР/);
  });

  it('сквозные профессии — последние, бессрочные и с ручным вводом профессии', () => {
    const crossProfession = def('cross_profession');
    expect(crossProfession.validMonths).toBeNull();
    expect(crossProfession.hasNote).toBe(true);
    expect(crossProfession.order).toBeGreaterThan(def('work_admission').order);
    // hasNote — единственный вид с текстовым уточнением.
    expect(OT_TRAININGS.filter(t => t.hasNote).map(t => t.kind)).toEqual(['cross_profession']);
  });

  it('виды отсортированы по order', () => {
    const orders = otTrainingsFor('employee').map(t => t.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it('периодичность соответствует регламенту', () => {
    expect(def('introductory').validMonths).toBeNull();
    expect(def('workplace').validMonths).toBe(3);
    expect(def('protocol').validMonths).toBe(36);
    expect(def('internship').validMonths).toBeNull();
    expect(def('work_admission').validMonths).toBeNull();
  });

  it('коды совпадают со справочником миграций 232 и 234 (иначе FK отобьёт запись)', () => {
    const seededIn = (file: string): string[] => {
      const sql = readFileSync(resolve(process.cwd(), `../docs/migrations/${file}`), 'utf8');
      const block = sql.slice(
        sql.indexOf('INSERT INTO public.ot_training_kinds'),
        sql.indexOf('ON CONFLICT (code) DO NOTHING'),
      );
      return [...block.matchAll(/\('([a-z_]+)'\)/g)].map(m => m[1]);
    };
    const seeded = [
      ...seededIn('232_ot_trainings.sql'),
      ...seededIn('234_employee_ot_trainings.sql'),
    ];
    const catalog = OT_TRAININGS.map(t => t.kind);
    expect([...catalog].sort()).toEqual([...new Set(seeded)].sort());
  });
});

describe('summarizeOtPerson', () => {
  const passed = (entries: Array<[string, string]>) => new Map(entries);

  it('пустой человек — alert и все виды в missing', () => {
    const s = summarizeOtPerson('contractor', passed([]), TODAY);
    expect(s.row_status).toBe('alert');
    expect(s.trainings).toEqual([]);
    expect(s.missing).toEqual(otTrainingsFor('contractor').map(t => t.kind));
  });

  it('всё заполнено и действует — ok', () => {
    const all = otTrainingsFor('contractor').map(t => [t.kind, '2026-07-01'] as [string, string]);
    const s = summarizeOtPerson('contractor', passed(all), TODAY);
    expect(s.row_status).toBe('ok');
    expect(s.missing).toEqual([]);
  });

  it('просроченный вид перевешивает истекающие — alert', () => {
    const all = otTrainingsFor('employee').map(t => [t.kind, '2026-07-01'] as [string, string]);
    const s = summarizeOtPerson('employee', passed([...all, ['workplace', '2026-01-01']]), TODAY);
    expect(s.row_status).toBe('alert');
  });

  it('всё заполнено, но что-то истекает — warning', () => {
    const all = otTrainingsFor('employee')
      .map(t => [t.kind, t.kind === 'workplace' ? '2026-05-26' : '2026-07-01'] as [string, string]);
    const s = summarizeOtPerson('employee', passed(all), TODAY);
    expect(s.row_status).toBe('warning');
  });

  it('у подрядчика программа А не попадает ни в trainings, ни в missing', () => {
    const s = summarizeOtPerson('contractor', passed([['program_a', '2026-07-01']]), TODAY);
    expect(s.trainings.some(t => t.kind === 'program_a')).toBe(false);
    expect(s.missing).not.toContain('program_a');
  });
});
