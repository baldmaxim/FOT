import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeAliveDepartmentSet, evaluateOrphanDepartmentDeactivationSafety } from './sigur-sync-structure.service.js';

describe('evaluateOrphanDepartmentDeactivationSafety', () => {
  const ORIGINAL_ENV = process.env.SIGUR_DEPT_DEACTIVATE_MAX;
  beforeEach(() => { delete process.env.SIGUR_DEPT_DEACTIVATE_MAX; });
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.SIGUR_DEPT_DEACTIVATE_MAX;
    else process.env.SIGUR_DEPT_DEACTIVATE_MAX = ORIGINAL_ENV;
  });

  it('пропускает одиночное удаление бригады', () => {
    const r = evaluateOrphanDepartmentDeactivationSafety(200, 199, 1);
    expect(r.shouldSkip).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('блокирует при усечённой выгрузке Sigur (< 50% активных)', () => {
    const r = evaluateOrphanDepartmentDeactivationSafety(200, 80, 120);
    expect(r.shouldSkip).toBe(true);
    expect(r.reason).toContain('looks truncated');
  });

  it('блокирует превышение абсолютного лимита по умолчанию (10)', () => {
    const r = evaluateOrphanDepartmentDeactivationSafety(100, 89, 11);
    expect(r.shouldSkip).toBe(true);
    expect(r.reason).toContain('exceeds limit 10');
    expect(r.reason).toContain('departments');
    expect(r.reason).toContain('department-deactivate skipped');
  });

  it('пропускает ровно 10 удалений на абсолютном лимите', () => {
    const r = evaluateOrphanDepartmentDeactivationSafety(100, 90, 10);
    expect(r.shouldSkip).toBe(false);
    expect(r.limit).toBe(10);
  });

  it('повышает лимит до 5% при крупной БД (500 активных → лимит 25)', () => {
    const ok = evaluateOrphanDepartmentDeactivationSafety(500, 476, 24);
    expect(ok.shouldSkip).toBe(false);
    expect(ok.limit).toBe(25);

    const fail = evaluateOrphanDepartmentDeactivationSafety(500, 474, 26);
    expect(fail.shouldSkip).toBe(true);
    expect(fail.reason).toContain('exceeds limit 25');
  });

  it('не считает выгрузку усечённой, когда sigur > db active (расширение whitelist)', () => {
    const r = evaluateOrphanDepartmentDeactivationSafety(100, 300, 2);
    expect(r.shouldSkip).toBe(false);
  });

  it('пустая БД (activeWithSigur=0) не падает', () => {
    const r = evaluateOrphanDepartmentDeactivationSafety(0, 50, 0);
    expect(r.shouldSkip).toBe(false);
  });

  it('уважает SIGUR_DEPT_DEACTIVATE_MAX через env', () => {
    process.env.SIGUR_DEPT_DEACTIVATE_MAX = '3';
    const r = evaluateOrphanDepartmentDeactivationSafety(50, 46, 4);
    expect(r.shouldSkip).toBe(true);
    expect(r.limit).toBe(Math.max(3, Math.ceil(50 * 0.05)));
  });

  it('уважает opts.absoluteLimit (приоритет над env)', () => {
    process.env.SIGUR_DEPT_DEACTIVATE_MAX = '100';
    const r = evaluateOrphanDepartmentDeactivationSafety(50, 46, 4, { absoluteLimit: 3 });
    expect(r.shouldSkip).toBe(true);
    expect(r.limit).toBe(Math.max(3, Math.ceil(50 * 0.05)));
  });

  it('пропускает одиночную удалённую бригаду (кейс Рахимова: 1 из 300)', () => {
    const r = evaluateOrphanDepartmentDeactivationSafety(300, 299, 1);
    expect(r.shouldSkip).toBe(false);
  });
});

describe('computeAliveDepartmentSet (Шаг 4: union фид ∪ ссылки сотрудников + предки)', () => {
  // Дерево FOT: su10 → central → {sekr, sekrobj, courier}.
  const parent = new Map<string, string | null>([
    ['su10', null],
    ['central', 'su10'],
    ['sekr', 'central'],
    ['sekrobj', 'central'],
    ['courier', 'central'],
  ]);
  // FOT-строки с их sigur_department_id.
  const existing = [
    { id: 'su10', sigur_department_id: 100 },
    { id: 'central', sigur_department_id: 200 },
    { id: 'sekr', sigur_department_id: 201 },
    { id: 'sekrobj', sigur_department_id: 202 },
    { id: 'courier', sigur_department_id: 203 },
  ];

  it('отдел в фиде → kept', () => {
    const kept = computeAliveDepartmentSet(existing, new Set([100, 201]), parent);
    expect(kept.has('sekr')).toBe(true);
    expect(kept.has('su10')).toBe(true);
  });

  it('отдел только по ссылке сотрудника (нет в фиде) → kept, плюс его предки', () => {
    // aliveSigurIds содержит 203 (courier) — пришёл из ссылок сотрудников.
    const kept = computeAliveDepartmentSet(existing, new Set([203]), parent);
    expect(kept.has('courier')).toBe(true);
    expect(kept.has('central')).toBe(true); // предок-контейнер
    expect(kept.has('su10')).toBe(true);
    expect(kept.has('sekr')).toBe(false); // соседний лист без ссылок — не kept
  });

  it('предок населённого листа защищён, даже если сам без прямых людей', () => {
    const kept = computeAliveDepartmentSet(existing, new Set([201, 202]), parent);
    expect(kept.has('central')).toBe(true);
    expect(kept.has('courier')).toBe(false); // курьер не в alive
  });

  it('кейс инцидента: секретариат удалён в Sigur (нет ни в фиде, ни в ссылках) → НЕ kept', () => {
    // alive = только корень компании su10 (100); секретариатская ветка отсутствует.
    const kept = computeAliveDepartmentSet(existing, new Set([100]), parent);
    expect(kept.has('su10')).toBe(true);
    expect(kept.has('central')).toBe(false);
    expect(kept.has('sekr')).toBe(false);
    expect(kept.has('sekrobj')).toBe(false);
    // → эти строки попадут в phantomCandidates и будут честно деактивированы (зеркало удаления).
  });

  it('пустой alive → пусто', () => {
    expect(computeAliveDepartmentSet(existing, new Set<number>(), parent).size).toBe(0);
  });

  it('цикл в parent_id не зацикливает', () => {
    const cyclic = new Map<string, string | null>([['a', 'b'], ['b', 'a']]);
    const ex = [{ id: 'a', sigur_department_id: 1 }, { id: 'b', sigur_department_id: 2 }];
    const kept = computeAliveDepartmentSet(ex, new Set([1]), cyclic);
    expect(kept.has('a')).toBe(true);
    expect(kept.has('b')).toBe(true);
  });
});
