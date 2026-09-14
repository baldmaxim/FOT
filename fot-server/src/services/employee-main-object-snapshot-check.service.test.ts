import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(), queryOne: vi.fn(), execute: vi.fn(), withTransaction: vi.fn(), withReadOnlySnapshot: vi.fn(),
}));
vi.mock('./timesheet-object.service.js', () => ({ buildObjectAttendanceData: vi.fn() }));
vi.mock('./attendance.service.js', () => ({ loadAttendanceAdjustments: vi.fn() }));

const { evaluateSnapshot } = await import('./employee-main-object-snapshot-check.service.js');

const OPTIONS = { expectedPeriodEnd: '2026-09-13', allowEmpty: false };
const okRun = { id: 7, status: 'ok', objectHoursReady: true, periodEnd: '2026-09-13' };

const base = () => ({
  activeRunId: 7,
  run: { ...okRun },
  foreignMainRows: 0,
  foreignObjectRows: 0,
  mainRows: [{ employeeId: 1, objectId: 'o1', objectName: 'Альфа', hours: 5 }],
  objectRows: [
    { employeeId: 1, objectId: 'o2', objectName: 'Бета', hours: 5 },
    { employeeId: 1, objectId: 'o1', objectName: 'Альфа', hours: 5 },
  ],
});

describe('evaluateSnapshot', () => {
  it('согласованный активный снимок — без провалов (тай-брейк по названию)', () => {
    expect(evaluateSnapshot(base(), OPTIONS).failures).toEqual([]);
  });

  it('нет указателя — провал, дальше не проверяется', () => {
    expect(evaluateSnapshot({ ...base(), activeRunId: null }, OPTIONS).failures).toEqual([
      'нет опубликованного поколения (state.active_run_id IS NULL)',
    ]);
  });

  it('активный запуск не ok / не ready / не вчера', () => {
    const report = evaluateSnapshot({ ...base(), run: { ...okRun, status: 'superseded', objectHoursReady: false, periodEnd: '2026-09-12' } }, OPTIONS);
    expect(report.failures).toHaveLength(3);
  });

  it('последняя запись журнала не важна: проверяется только активный запуск', () => {
    // Вход не содержит «последнего запуска» вовсе — только активный.
    expect(evaluateSnapshot(base(), OPTIONS).info[0]).toContain('активный запуск 7');
  });

  it('строки чужих поколений — провал', () => {
    const report = evaluateSnapshot({ ...base(), foreignMainRows: 3, foreignObjectRows: 1 }, OPTIONS);
    expect(report.failures.join('\n')).toMatch(/3 строк основного снимка[\s\S]*1 строк списков/);
  });

  it('основной объект ≠ первому объекту списка — провал', () => {
    const input = base();
    input.mainRows = [{ employeeId: 1, objectId: 'o2', objectName: 'Бета', hours: 5 }];
    expect(evaluateSnapshot(input, OPTIONS).failures[0]).toContain('основной объект ≠ первому');
  });

  it('расхождение множеств сотрудников — провал в обе стороны', () => {
    const input = base();
    input.mainRows.push({ employeeId: 2, objectId: 'o1', objectName: 'Альфа', hours: 1 });
    input.objectRows.push({ employeeId: 3, objectId: 'o1', objectName: 'Альфа', hours: 1 });
    const failures = evaluateSnapshot(input, OPTIONS).failures.join('\n');
    expect(failures).toContain('без списка объектов');
    expect(failures).toContain('без основного объекта');
  });

  it('пустой готовый снимок: провал гейта без --allow-empty, валиден с ним', () => {
    const input = { ...base(), mainRows: [], objectRows: [] };
    expect(evaluateSnapshot(input, OPTIONS).failures).toHaveLength(1);
    expect(evaluateSnapshot(input, { ...OPTIONS, allowEmpty: true }).failures).toEqual([]);
  });
});
