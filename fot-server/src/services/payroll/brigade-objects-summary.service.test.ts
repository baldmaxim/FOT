import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IBrigadeSalaryObjectFacts, IBrigadeSalaryResultRow, IBrigadeShares } from './brigade-salary.service.js';

// Сведение — чистая функция; оркестрация — на заглушках расчёта: что читается пакетом, что считается, чего нет.
const svc = vi.hoisted(() => ({
  peekBrigadeSharesMany: vi.fn(),
  previewClosedBrigadeShares: vi.fn(),
  computeBrigadePreliminaryShares: vi.fn(),
  resolvePreliminaryAsOf: vi.fn(),
  getBrigadeSalary: vi.fn(),
  loadBrigadeContexts: vi.fn(),
  loadBrigadeSalaryInputs: vi.fn(),
  namesOf: vi.fn(),
  query: vi.fn(),
}));

vi.mock('./brigade-salary.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./brigade-salary.service.js')>()),
  peekBrigadeSharesMany: svc.peekBrigadeSharesMany,
  previewClosedBrigadeShares: svc.previewClosedBrigadeShares,
  computeBrigadePreliminaryShares: svc.computeBrigadePreliminaryShares,
  resolvePreliminaryAsOf: svc.resolvePreliminaryAsOf,
  getBrigadeSalary: svc.getBrigadeSalary,
}));
vi.mock('./payroll-calc-brigades.service.js', () => ({
  withBrigadeSlot: <T>(task: () => Promise<T>): Promise<T> => task(),
}));
vi.mock('./payroll-calc-preliminary.service.js', () => ({ loadBrigadeContexts: svc.loadBrigadeContexts }));
vi.mock('./brigade-salary-inputs.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./brigade-salary-inputs.service.js')>()),
  loadBrigadeSalaryInputs: svc.loadBrigadeSalaryInputs,
}));
vi.mock('./timesheet-salary.service.js', () => ({ namesOf: svc.namesOf }));
vi.mock('../../config/postgres.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../config/postgres.js')>()),
  query: svc.query,
}));

import {
  aggregateBrigadeObjects,
  getBrigadeObjectsSummary,
  type IBrigadeSummaryInput,
} from './brigade-objects-summary.service.js';

const WAVE = '2b1f7a0e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const DOM56 = '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce';
const UNKNOWN = '__unknown_object__';
const CURRENT = '__current_activity__';

const part = (objectKey: string, days: Record<string, number>, minutes: number) => ({
  object_key: objectKey, days, counted_minutes: minutes, weight: minutes * 10, amount: null,
});

const row = (employeeId: number, parts: ReturnType<typeof part>[]): IBrigadeSalaryResultRow => ({
  employee_id: employeeId,
  ktu: '1.0',
  counted_minutes: parts.reduce((sum, item) => sum + item.counted_minutes, 0),
  amount: null,
  source: 'live',
  objects: parts,
});

const fact = (
  objectKey: string,
  objectName: string,
  output: string | null,
  state: IBrigadeSalaryObjectFacts['state'],
): IBrigadeSalaryObjectFacts => ({ object_key: objectKey, object_name: objectName, output, state, total_weight: 0 });

const brigade = (over: Partial<IBrigadeSummaryInput> & Pick<IBrigadeSummaryInput, 'department_id' | 'name'>): IBrigadeSummaryInput => ({
  state: 'fixed', mode: 'objects', distribution: 'ok', rows: [], objects: [], visible: true, ...over,
});

const NAMES = new Map([[1, 'Абдуллаев А.'], [2, 'Бобоев Б.'], [3, 'Валиев В.'], [5, 'Гаипов Г.']]);

describe('aggregateBrigadeObjects — стоимость часа только по внёсшим выработку на объект', () => {
  it('две бригады на объекте, выработка у одной: в стоимости часа только она, остальные — с часами и причиной', () => {
    const [object] = aggregateBrigadeObjects([
      brigade({
        department_id: 'b', name: 'бр.Бобоев',
        objects: [fact(WAVE, 'ЖК Wave', null, 'no_output')],
        rows: [row(3, [part(WAVE, { '2026-10-01': 10 }, 600)])],
      }),
      brigade({
        department_id: 'a', name: 'бр.Абдуллаев',
        objects: [fact(WAVE, 'ЖК Wave', '300000.00', 'ok')],
        rows: [
          row(1, [part(WAVE, { '2026-10-01': 8.4, '2026-10-02': 7.6 }, 960)]),
          row(2, [part(WAVE, { '2026-10-01': 3.5 }, 210)]),
        ],
      }),
    ], NAMES, new Map());

    expect(object).toMatchObject({
      object_key: WAVE,
      object_name: 'ЖК Wave',
      output_total: '300000.00',
      output_in_rate: '300000.00',
      rated_minutes: 1170,
      counted_minutes: 1770,
      hours: 30,
      people: 3,
      brigades_in_rate: 1,
    });
    expect(object.brigades.map(item => item.name)).toEqual(['бр.Абдуллаев', 'бр.Бобоев']);
    expect(object.brigades[0]).toMatchObject({
      in_rate: true, exclusion: null, output_amount: '300000.00', people: 2, hours: 20, counted_minutes: 1170,
    });
    // Часы — Σ дневных, округлённых до целых (8,4 → 8, 7,6 → 8, 3,5 → 4), как под стрелкой «Бригад».
    expect(object.brigades[0].members).toEqual([
      { employee_id: 1, full_name: 'Абдуллаев А.', hours: 16, counted_minutes: 960 },
      { employee_id: 2, full_name: 'Бобоев Б.', hours: 4, counted_minutes: 210 },
    ]);
    expect(object.brigades[1]).toMatchObject({
      in_rate: false, exclusion: 'no_output', output_amount: null, people: 1, hours: 10, counted_minutes: 600,
    });
  });

  it('доли не сходятся: сумма в «Выработке» объекта, но не в стоимости часа', () => {
    const [object] = aggregateBrigadeObjects([
      brigade({
        department_id: 'a', name: 'бр.А',
        objects: [fact(WAVE, 'ЖК Wave', '300000.00', 'ok')],
        rows: [row(1, [part(WAVE, { '2026-10-01': 8 }, 480)])],
      }),
      brigade({
        department_id: 'b', name: 'бр.Б',
        objects: [fact(WAVE, 'ЖК Wave', '100000.00', 'share_conflict')],
        rows: [row(2, [part(WAVE, { '2026-10-01': 8 }, 480)])],
      }),
    ], NAMES, new Map());
    expect(object).toMatchObject({
      output_total: '400000.00', output_in_rate: '300000.00', rated_minutes: 480, brigades_in_rate: 1,
    });
    expect(object.brigades[1]).toMatchObject({ output_amount: '100000.00', in_rate: false, exclusion: 'share_conflict' });
  });

  it('сумма бригаде (341) и ошибка расчёта бригады в стоимость часа не входят', () => {
    const [object] = aggregateBrigadeObjects([
      brigade({
        department_id: 'a', name: 'бр.А', mode: 'brigade',
        objects: [fact(WAVE, 'ЖК Wave', null, 'by_brigade')],
        rows: [row(1, [part(WAVE, { '2026-10-01': 8 }, 480)])],
      }),
      brigade({
        department_id: 'b', name: 'бр.Б', distribution: 'error',
        objects: [fact(WAVE, 'ЖК Wave', '50000.00', 'ok')],
        rows: [row(2, [part(WAVE, { '2026-10-01': 8 }, 480)])],
      }),
    ], NAMES, new Map());
    expect(object).toMatchObject({ output_total: '50000.00', output_in_rate: null, rated_minutes: 0, brigades_in_rate: 0 });
    expect(object.brigades.map(item => item.exclusion)).toEqual(['by_brigade', 'error']);
    expect(object.brigades[0].output_amount).toBeNull();
  });

  it('переведённый в месяце из бригады в бригаду — один человек на объекте', () => {
    const [object] = aggregateBrigadeObjects([
      brigade({ department_id: 'a', name: 'бр.А', rows: [row(5, [part(WAVE, { '2026-10-01': 8 }, 480)])] }),
      brigade({ department_id: 'b', name: 'бр.Б', rows: [row(5, [part(WAVE, { '2026-10-20': 8 }, 480)])] }),
    ], NAMES, new Map());
    expect(object.people).toBe(1);
    expect(object.brigades.map(item => item.people)).toEqual([1, 1]);
  });

  it('копейки складываются без плавающей точки: 0,10 + 0,20 = 0,30', () => {
    const [object] = aggregateBrigadeObjects([
      brigade({
        department_id: 'a', name: 'бр.А',
        objects: [fact(WAVE, 'ЖК Wave', '0.10', 'ok')],
        rows: [row(1, [part(WAVE, { '2026-10-01': 1 }, 60)])],
      }),
      brigade({
        department_id: 'b', name: 'бр.Б',
        objects: [fact(WAVE, 'ЖК Wave', '0.2', 'ok')],
        rows: [row(2, [part(WAVE, { '2026-10-01': 1 }, 60)])],
      }),
    ], NAMES, new Map());
    expect(object.output_total).toBe('0.30');
    expect(object.output_in_rate).toBe('0.30');
  });

  it('имя — из справочника (в снимке старое); «Текущая деятельность» и «Не определён» — в конце', () => {
    const objects = aggregateBrigadeObjects([
      brigade({
        department_id: 'a', name: 'бр.А',
        objects: [
          fact(UNKNOWN, 'Не определён', null, 'no_output'),
          fact(CURRENT, 'Текущая деятельность', null, 'no_output'),
          fact(WAVE, 'Не определён', null, 'no_output'),
          fact(DOM56, 'ЖК Дом 56', null, 'no_output'),
        ],
        rows: [row(1, [
          part(UNKNOWN, { '2026-10-01': 1 }, 60),
          part(CURRENT, { '2026-10-02': 1 }, 60),
          part(WAVE, { '2026-10-03': 1 }, 60),
          part(DOM56, { '2026-10-04': 1 }, 60),
        ])],
      }),
    ], NAMES, new Map([[WAVE, 'ЖК Wave']]));
    // Порядок по-русски, как у «Зарплаты по объектам» (compareBrigadeObjects): кириллица раньше латиницы.
    expect(objects.map(item => item.object_name)).toEqual(['ЖК Дом 56', 'ЖК Wave', 'Текущая деятельность', 'Не определён']);
  });

  it('скрытая бригада: ни ФИО, ни id — только итоги пары', () => {
    const [object] = aggregateBrigadeObjects([
      brigade({
        department_id: 'a', name: 'бр.А', visible: false,
        objects: [fact(WAVE, 'ЖК Wave', '1000.00', 'ok')],
        rows: [row(1, [part(WAVE, { '2026-10-01': 8 }, 480)]), row(2, [part(WAVE, { '2026-10-01': 4 }, 240)])],
      }),
    ], NAMES, new Map());
    expect(object.brigades[0]).toMatchObject({ members: null, people: 2, hours: 12, counted_minutes: 720, in_rate: true });
    expect(JSON.stringify(object)).not.toContain('Абдуллаев');
    expect(JSON.stringify(object)).not.toContain('employee_id');
  });

  it('выработка внесена на объект без часов бригады — видна в «Выработке», в стоимость часа не идёт', () => {
    const [object] = aggregateBrigadeObjects([
      brigade({ department_id: 'a', name: 'бр.А', objects: [fact(WAVE, 'ЖК Wave', '5000.00', 'nothing_to_distribute')] }),
    ], NAMES, new Map());
    expect(object).toMatchObject({ output_total: '5000.00', output_in_rate: null, people: 0, hours: 0 });
    expect(object.brigades[0]).toMatchObject({ exclusion: 'nothing_to_distribute', members: [] });
  });

  it('бригада без часов и без выработки на объекте не показывается', () => {
    expect(aggregateBrigadeObjects([
      brigade({ department_id: 'a', name: 'бр.А', objects: [fact(WAVE, 'ЖК Wave', null, 'no_output')] }),
    ], NAMES, new Map())).toEqual([]);
  });
});

describe('getBrigadeObjectsSummary — только чтение, как «Расчёты»', () => {
  const MONTH = '2026-11';
  const AS_OF = '2026-11-23';
  const BRIGADES = [
    { department_id: 'fixed', name: 'бр.Закрытая' },
    { department_id: 'needs', name: 'бр.Без снимка' },
    { department_id: 'open', name: 'бр.Открытая' },
  ];
  const sharesOf = (employeeId: number, objectKey = WAVE): IBrigadeShares => ({
    state: 'open', mode: 'objects', distribution: 'ok', output_amount: '1000.00',
    rows: [row(employeeId, [part(objectKey, { '2026-11-03': 8 }, 480)])],
    objects: [fact(objectKey, 'ЖК Wave', '1000.00', 'ok')],
  });
  const OPEN_INPUTS = { outputs: new Map(), brigadeOutput: null, ktu: new Map() };
  const CONTEXT = { departmentId: 'open', memberIds: [3], memberships: [], windows: new Map() };

  beforeEach(() => {
    vi.resetAllMocks();
    svc.resolvePreliminaryAsOf.mockReturnValue(AS_OF);
    svc.peekBrigadeSharesMany.mockResolvedValue(new Map<string, unknown>([
      ['fixed', { state: 'fixed', shares: { ...sharesOf(1), state: 'fixed' } }],
      ['needs', { state: 'needs_fix' }],
      ['open', { state: 'open', shares: { state: 'open' }, inputs: OPEN_INPUTS }],
    ]));
    svc.previewClosedBrigadeShares.mockResolvedValue({ ...sharesOf(2), state: 'fixed' });
    svc.loadBrigadeContexts.mockResolvedValue(new Map([['open', CONTEXT]]));
    svc.computeBrigadePreliminaryShares.mockResolvedValue(sharesOf(3));
    svc.namesOf.mockImplementation(async (ids: number[]) => new Map(ids.map(id => [id, NAMES.get(id) ?? ''])));
    svc.query.mockResolvedValue([{ id: WAVE, name: 'ЖК Wave' }]);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const summary = (canRead: (id: string) => Promise<boolean> = async () => true) => (
    getBrigadeObjectsSummary(MONTH, BRIGADES, canRead)
  );

  it('снимок — из пакета, без снимка — расчёт без записи, открытая — живой табель; getBrigadeSalary не вызывается', async () => {
    const result = await summary();

    expect(svc.peekBrigadeSharesMany).toHaveBeenCalledWith(['fixed', 'needs', 'open'], MONTH);
    expect(svc.previewClosedBrigadeShares).toHaveBeenCalledTimes(1);
    expect(svc.previewClosedBrigadeShares).toHaveBeenCalledWith('needs', MONTH);
    expect(svc.loadBrigadeContexts).toHaveBeenCalledWith(['open'], '2026-11-01', AS_OF);
    expect(svc.computeBrigadePreliminaryShares).toHaveBeenCalledTimes(1);
    expect(svc.computeBrigadePreliminaryShares).toHaveBeenCalledWith('open', MONTH, AS_OF, OPEN_INPUTS, CONTEXT);
    expect(svc.getBrigadeSalary).not.toHaveBeenCalled();
    expect(svc.loadBrigadeSalaryInputs).not.toHaveBeenCalled();

    const [object] = result.objects;
    expect(object.brigades.map(item => [item.department_id, item.state])).toEqual([
      ['needs', 'fixed'], ['fixed', 'fixed'], ['open', 'preliminary'],
    ]);
    expect(object).toMatchObject({ output_total: '3000.00', rated_minutes: 1440, people: 3 });
    expect(result.failed_brigades).toEqual([]);
  });

  it('месяц открыли, пока читали: needs_fix без закрытия — считается как открытая, ввод читается заново', async () => {
    svc.previewClosedBrigadeShares.mockResolvedValue(null);
    svc.loadBrigadeContexts.mockResolvedValue(new Map([
      ['needs', { ...CONTEXT, departmentId: 'needs' }], ['open', CONTEXT],
    ]));
    svc.loadBrigadeSalaryInputs.mockResolvedValue(OPEN_INPUTS);

    const result = await summary();

    expect(svc.loadBrigadeContexts).toHaveBeenCalledWith(['needs', 'open'], '2026-11-01', AS_OF);
    expect(svc.loadBrigadeSalaryInputs).toHaveBeenCalledWith('needs', '2026-11-01');
    expect(result.objects[0].brigades.find(item => item.department_id === 'needs')?.state).toBe('preliminary');
  });

  it('отказ одной бригады — остальные на месте, она в failed_brigades', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    svc.computeBrigadePreliminaryShares.mockRejectedValue(new Error('timeout'));

    const result = await summary();

    expect(result.failed_brigades).toEqual([{ department_id: 'open', name: 'бр.Открытая' }]);
    expect(result.objects[0].brigades.map(item => item.department_id)).toEqual(['needs', 'fixed']);
    expect(error).toHaveBeenCalled();
  });

  it('ФИО грузятся только для открытых бригад; доступ спрашивается по разу на бригаду', async () => {
    const canRead = vi.fn(async (id: string) => id !== 'open');

    const result = await summary(canRead);

    expect(canRead).toHaveBeenCalledTimes(3);
    expect(svc.namesOf).toHaveBeenCalledWith([1, 2]);
    const hidden = result.objects[0].brigades.find(item => item.department_id === 'open');
    expect(hidden).toMatchObject({ members: null, people: 1 });
  });

  it('будущий месяц (считать нечего) — состав не читается, ничего не считается', async () => {
    svc.resolvePreliminaryAsOf.mockReturnValue(null);
    svc.peekBrigadeSharesMany.mockResolvedValue(new Map([
      ['fixed', { state: 'open', shares: {}, inputs: OPEN_INPUTS }],
      ['needs', { state: 'open', shares: {}, inputs: OPEN_INPUTS }],
      ['open', { state: 'open', shares: {}, inputs: OPEN_INPUTS }],
    ]));

    const result = await summary();

    expect(svc.loadBrigadeContexts).not.toHaveBeenCalled();
    expect(svc.computeBrigadePreliminaryShares).not.toHaveBeenCalled();
    expect(result).toEqual({ month: MONTH, objects: [], failed_brigades: [] });
  });
});
