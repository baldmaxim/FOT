/**
 * Сводка по руководителю (п. 3.5): Σfact / Σplan, а НЕ среднее процентов по месяцам.
 * Разница на реальных данных доходит до десятков процентных пунктов, поэтому кейс
 * зафиксирован тестом, а не комментарием.
 *
 * Рядом — окно авто-периода: приоритет источников начала расчёта и оба клампа.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import { queryOne } from '../config/postgres.js';
import {
  filterRowsByMonths,
  resolveCalcWindow,
  summarizeByObject,
  summarizeCompletion,
  OBJECT_KPI_MAX_AUTO_MONTHS,
  OBJECT_KPI_REPORT_SQL,
  type ObjectKpiReportRow,
} from './object-kpi-report.service.js';

const row = (plan: string | null, fact: string): ObjectKpiReportRow =>
  ({ plan_amount: plan, fact_amount: fact } as ObjectKpiReportRow);

describe('summarizeCompletion', () => {
  it('считает отношение сумм, а не среднее процентов', () => {
    // По месяцам: 100 % и 10 %. Среднее дало бы 55 %, отношение сумм — 19 %.
    const result = summarizeCompletion([
      row('1000000.00', '1000000.00'),
      row('9000000.00', '900000.00'),
    ]);

    expect(result.total_plan).toBe(10_000_000);
    expect(result.total_fact).toBe(1_900_000);
    expect(result.completion_pct).toBe(19);
  });

  it('строки без плана не входят в процент, но их факт не теряется', () => {
    // План NULL — данных за месяц не было. Подстановка нуля занизила бы процент,
    // а выброшенный факт спрятал бы подписанные акты: он уходит отдельным полем.
    const result = summarizeCompletion([
      row('1000000.00', '1000000.00'),
      row(null, '500000.00'),
    ]);

    expect(result.total_plan).toBe(1_000_000);
    expect(result.total_fact).toBe(1_000_000);
    expect(result.total_fact_unplanned).toBe(500_000);
    expect(result.completion_pct).toBe(100);
  });

  it('нулевой суммарный план → процент не считается', () => {
    // Полностью закрытый объект не должен выглядеть провалившим KPI.
    expect(summarizeCompletion([row('0.00', '0.00')]).completion_pct).toBeNull();
    expect(summarizeCompletion([]).completion_pct).toBeNull();
  });
});

describe('filterRowsByMonths', () => {
  const monthRow = (periodMonth: string) => ({ period_month: periodMonth } as ObjectKpiReportRow);
  const rows = ['2026-07-01', '2026-08-01', '2026-09-01'].map(monthRow);

  it('без набора месяцев строки не трогает', () => {
    expect(filterRowsByMonths(rows, null)).toBe(rows);
  });

  it('оставляет только выбранные месяцы, в том числе вразброс', () => {
    const result = filterRowsByMonths(rows, new Set(['2026-07', '2026-09']));
    expect(result.map((item) => item.period_month)).toEqual(['2026-07-01', '2026-09-01']);
  });
});

describe('summarizeByObject', () => {
  const objectRow = (over: Partial<ObjectKpiReportRow>): ObjectKpiReportRow => ({
    skud_object_id: 'obj-a',
    object_name: 'ЖК А',
    contract_id: 'c-a',
    period_month: '2026-07-01',
    contract_total: '1000.00',
    ks2_cumulative_before: '100.00',
    remainder: '900.00',
    plan_amount: '100.00',
    fact_amount: '50.00',
    primary_manager_name: 'Иванов И. И.',
    ...over,
  } as ObjectKpiReportRow);

  it('строка на объект: договор/КС-6/остаток — из первого месяца, план и факт — суммой', () => {
    const [stat] = summarizeByObject([
      // Порядок SQL — по объекту и месяцу, но и перемешанные строки дают первый месяц.
      objectRow({ period_month: '2026-08-01', contract_total: '1100.00', ks2_cumulative_before: '150.00',
        remainder: '950.00', plan_amount: '300.00', fact_amount: '240.00' }),
      objectRow({}),
    ]);

    expect(stat).toMatchObject({
      skud_object_id: 'obj-a',
      contract_total: '1000.00',
      ks2_cumulative_before: '100.00',
      remainder: '900.00',
      plan_amount: 400,
      fact_amount: 290,
    });
    // Σфакт / Σплан, а не среднее процентов (50 % и 80 % → 72,5 %).
    expect(stat.completion_pct).toBe(72.5);
  });

  it('руководители месяцев — без повторов, по порядку месяцев', () => {
    const [stat] = summarizeByObject([
      objectRow({ period_month: '2026-07-01', primary_manager_name: 'Иванов И. И.' }),
      objectRow({ period_month: '2026-08-01', primary_manager_name: 'Петров П. П.' }),
      objectRow({ period_month: '2026-09-01', primary_manager_name: 'Иванов И. И.' }),
      objectRow({ period_month: '2026-10-01', primary_manager_name: null }),
    ]);
    expect(stat.manager_names).toEqual(['Иванов И. И.', 'Петров П. П.']);
  });

  it('объекты без договора в таблицу не попадают, порядок объектов — как у строк', () => {
    const stats = summarizeByObject([
      objectRow({ skud_object_id: 'obj-b', object_name: 'База Б' }),
      objectRow({ skud_object_id: 'obj-c', object_name: 'Офис', contract_id: null, plan_amount: null }),
      objectRow({ skud_object_id: 'obj-a', object_name: 'ЖК А' }),
    ]);
    expect(stats.map((stat) => stat.skud_object_id)).toEqual(['obj-b', 'obj-a']);
  });

  it('факт месяцев без плана входит в КС-2, но не в процент; без плана вовсе — план и % пустые', () => {
    const [mixed] = summarizeByObject([
      objectRow({ plan_amount: '100.00', fact_amount: '100.00' }),
      objectRow({ period_month: '2026-08-01', plan_amount: null, fact_amount: '30.00' }),
    ]);
    expect(mixed).toMatchObject({ plan_amount: 100, fact_amount: 130, completion_pct: 100 });

    const [noPlan] = summarizeByObject([objectRow({ plan_amount: null, fact_amount: '30.00' })]);
    expect(noPlan).toMatchObject({ plan_amount: null, fact_amount: 30, completion_pct: null });
  });
});

describe('resolveCalcWindow', () => {
  const OBJECT_ID = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    // Фиксируем «сегодня»: окно строится от текущего месяца по МСК.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-14T09:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const withStart = (startMonth: string | null) => {
    (queryOne as unknown as { mockResolvedValue: (v: unknown) => void })
      .mockResolvedValue({ start_month: startMonth });
  };

  it('окно идёт от начала расчёта до текущего месяца', async () => {
    withStart('2025-01');
    await expect(resolveCalcWindow([OBJECT_ID])).resolves.toEqual({ from: '2025-01', to: '2026-08' });
  });

  it('пустой скоуп не ходит в БД: окно из одного текущего месяца', async () => {
    await expect(resolveCalcWindow([])).resolves.toEqual({ from: '2026-08', to: '2026-08' });
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('данных нет вовсе → окно из одного текущего месяца', async () => {
    withStart(null);
    await expect(resolveCalcWindow([OBJECT_ID])).resolves.toEqual({ from: '2026-08', to: '2026-08' });
  });

  it('начало глубже потолка подрезается', async () => {
    withStart('2005-03');
    const result = await resolveCalcWindow([OBJECT_ID]);
    // Ровно OBJECT_KPI_MAX_AUTO_MONTHS месяцев включительно: 2016-09 … 2026-08.
    expect(result).toEqual({ from: '2016-09', to: '2026-08' });
    const [fy, fm] = result.from.split('-').map(Number);
    const [ty, tm] = result.to.split('-').map(Number);
    expect((ty * 12 + tm) - (fy * 12 + fm) + 1).toBe(OBJECT_KPI_MAX_AUTO_MONTHS);
  });

  it('начало в будущем не даёт from > to', async () => {
    // Договор с первым расчётным месяцем в следующем году: иначе окно упало бы
    // на собственной валидации «начало периода позже конца».
    withStart('2027-01');
    await expect(resolveCalcWindow([OBJECT_ID])).resolves.toEqual({ from: '2026-08', to: '2026-08' });
  });

  it('приоритет plan_start_month обеспечивается запросом, а не клиентом', async () => {
    withStart('2025-01');
    await resolveCalcWindow([OBJECT_ID]);

    const sql = (queryOne as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string;
    // COALESCE(plan_start_month, LEAST(...)) — явный первый расчётный месяц перекрывает
    // дату договора и первые акты, иначе договор 2020 года открыл бы период с 2020-го.
    expect(sql).toContain('COALESCE(');
    expect(sql.indexOf('s.plan_start_month')).toBeLessThan(sql.indexOf('LEAST('));
  });
});

/**
 * Структурные проверки SQL-константы. Живой БД в юнит-тестах нет, поэтому это не проверка
 * чисел, а страховка от случайного отката двух правок, которые молча ломают отчёт.
 */
describe('OBJECT_KPI_REPORT_SQL', () => {
  it('отдаёт накопительный итог на начало месяца', () => {
    // На нём держится колонка «КС-6 на начало» и сходимость строки: остаток считается
    // от этой величины (п. 2.2), иначе «Договор с ДС − КС-6» не даёт «Остаток».
    expect(OBJECT_KPI_REPORT_SQL).toContain('ks2_cumulative_before');
  });

  it('не читает реестр КС-6: колонка отчёта — производная от подписанных КС-2', () => {
    // Проверяем обращение к таблице, а не подстроку «ks6»: иначе тест сломает
    // любой комментарий с этим словом.
    expect(OBJECT_KPI_REPORT_SQL).not.toContain('FROM object_ks6_entries');
  });

  it('превышение договора ловится с учётом факта текущего месяца', () => {
    expect(OBJECT_KPI_REPORT_SQL)
      .toContain('x.contract_total_calc < (x.ks2_cumulative_before_calc + x.fact_net)');
  });

  it('ручной план подменяет только сумму — и в плане, и в знаменателе процента', () => {
    // Остаток, число месяцев и контрольная дата продолжают считаться формулой: правка
    // суммы не должна тихо закрывать месяц.
    const overrideUses = OBJECT_KPI_REPORT_SQL.match(/COALESCE\(x\.override_plan_amount, x\.plan_amount_calc\)/g);
    expect(overrideUses).toHaveLength(2);
    // У строки data_incomplete ручная сумма не применяется — там нет расчётного плана.
    expect(OBJECT_KPI_REPORT_SQL)
      .toContain("CASE WHEN mp.status IN ('open', 'fixed', 'corrected') THEN mp.override_plan_amount END");
  });

  it('зафиксированный месяц закрепляет только ЗОС, контрольную дату и число месяцев', () => {
    // П. 6.3: перенос ЗОС не пересчитывает закрытый месяц. Деньги — всегда по текущим данным:
    // замороженный целиком снимок показывал бы остаток, который с актами уже не сходится.
    expect(OBJECT_KPI_REPORT_SQL).toContain('WHEN e.is_fixed THEN e.snap_months_remaining');
    expect(OBJECT_KPI_REPORT_SQL).toContain('x.remainder_calc                                     AS remainder');
    expect(OBJECT_KPI_REPORT_SQL).not.toContain('snap_remainder');
    expect(OBJECT_KPI_REPORT_SQL).not.toContain('use_snapshot');
    expect(OBJECT_KPI_REPORT_SQL).not.toContain('plan_drift');
  });

  it('качество данных и неполнота проверяются по итоговой ЗОС', () => {
    // Иначе очищенная ЗОС договора сделала бы закрытый месяц «неполным», и snapshotValues
    // обнулил бы его ревизию при пересмотре.
    expect(OBJECT_KPI_REPORT_SQL)
      .toContain("WHEN x.effective_planned_zos_date IS NULL THEN 'no_planned_zos_date'");
    expect(OBJECT_KPI_REPORT_SQL).not.toContain("WHEN x.planned_zos_date IS NULL THEN 'no_planned_zos_date'");
    expect(OBJECT_KPI_REPORT_SQL).toContain('COALESCE(x.effective_control_date < x.period_month, false)');
  });

  it('ручной остаток становится точкой отсчёта накопления', () => {
    // Ветка живёт в baselines: это единственное место, где рождается «накоплено до окна».
    expect(OBJECT_KPI_REPORT_SQL)
      .toContain('WHEN s.opening_remainder IS NOT NULL AND s.plan_start_month IS NOT NULL THEN');
    // Конвертация «остаток -> накопленный объём» идёт ДО слагаемого зазора: иначе акты
    // между plan_start_month и началом окна потерялись бы.
    const branch = OBJECT_KPI_REPORT_SQL.slice(
      OBJECT_KPI_REPORT_SQL.indexOf('WHEN s.opening_remainder IS NOT NULL'),
      OBJECT_KPI_REPORT_SQL.indexOf('END AS ks2_before_window'),
    );
    expect(branch.indexOf('- s.opening_remainder'))
      .toBeLessThan(branch.indexOf('k.customer_signed_date >= s.plan_start_month'));
    // GREATEST(...,0) вокруг конвертации подменил бы введённое число при остатке выше
    // стоимости договора — таблица показала бы не то, что сохранил экономист.
    expect(branch).not.toContain('GREATEST(COALESCE(s.base_amount');
  });

  it('решётка режется только по plan_start_month', () => {
    // Ручной остаток не должен скрывать месяцы сам по себе: точку отсчёта задаёт
    // первый расчётный месяц, и запрет на закрытые месяцы живёт в сервисе, не в SQL.
    expect(OBJECT_KPI_REPORT_SQL)
      .toContain('AND (s.plan_start_month IS NULL OR m.period_month >= s.plan_start_month)');
    expect(OBJECT_KPI_REPORT_SQL).not.toContain('m.period_month >= s.opening_remainder');
  });

  it('руководитель месяца выбирается детерминированно', () => {
    // Без второго ключа при смене 15/15 победитель зависит от порядка строк в плане.
    expect(OBJECT_KPI_REPORT_SQL).toContain('ORDER BY t.days DESC, t.valid_from DESC');
  });
});
