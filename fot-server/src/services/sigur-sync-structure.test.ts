import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeProtectedDepartments, evaluateOrphanDepartmentDeactivationSafety, selectPhantomsToDeactivate } from './sigur-sync-structure.service.js';

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

describe('selectPhantomsToDeactivate (guard A: не гасить населённые отделы)', () => {
  const phantoms = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('гасит все фантомы, если ни в одном нет активных привязок', () => {
    const r = selectPhantomsToDeactivate(phantoms, new Set<string>());
    expect(r.toDeactivate.map(d => d.id)).toEqual(['a', 'b', 'c']);
    expect(r.protectedFromDeactivation).toBe(0);
  });

  it('защищает населённые, гасит только пустые', () => {
    const r = selectPhantomsToDeactivate(phantoms, new Set(['b']));
    expect(r.toDeactivate.map(d => d.id)).toEqual(['a', 'c']);
    expect(r.protectedFromDeactivation).toBe(1);
  });

  it('кейс секретариата: все фантомы населены → ни один не гасится', () => {
    const r = selectPhantomsToDeactivate(phantoms, new Set(['a', 'b', 'c']));
    expect(r.toDeactivate).toEqual([]);
    expect(r.protectedFromDeactivation).toBe(3);
  });

  it('пустой список кандидатов безопасен', () => {
    const r = selectPhantomsToDeactivate([] as { id: string }[], new Set(['a']));
    expect(r.toDeactivate).toEqual([]);
    expect(r.protectedFromDeactivation).toBe(0);
  });
});

describe('computeProtectedDepartments (guard A: населённые + их предки)', () => {
  // Ветка инцидента: central → {sekr(люди), sekrobj, courier(люди)}; central — родитель без прямых людей.
  const parent = new Map<string, string | null>([
    ['central', 'su10'],
    ['sekr', 'central'],
    ['sekrobj', 'central'],
    ['courier', 'central'],
    ['su10', null],
  ]);

  it('защищает населённый отдел и его предка-кандидата (родитель ветки не гаснет)', () => {
    const candidates = ['central', 'sekr', 'sekrobj', 'courier'];
    const populated = new Set(['sekr', 'courier']); // прямые люди только в листьях
    const prot = computeProtectedDepartments(candidates, populated, parent);
    expect(prot.has('sekr')).toBe(true);
    expect(prot.has('courier')).toBe(true);
    expect(prot.has('central')).toBe(true); // предок населённых листьев — тоже защищён
    expect(prot.has('sekrobj')).toBe(false); // пустой лист гасим
  });

  it('не защищает предка, если он НЕ кандидат (su10 активен и не в списке)', () => {
    const candidates = ['sekr'];
    const prot = computeProtectedDepartments(candidates, new Set(['sekr']), parent);
    expect(prot.has('sekr')).toBe(true);
    expect(prot.has('su10')).toBe(false);
    expect(prot.has('central')).toBe(false);
  });

  it('ничего не защищает, если нет населённых', () => {
    const prot = computeProtectedDepartments(['central', 'sekr'], new Set<string>(), parent);
    expect(prot.size).toBe(0);
  });

  it('цикл в parent_id не зацикливает', () => {
    const cyclic = new Map<string, string | null>([['a', 'b'], ['b', 'a']]);
    const prot = computeProtectedDepartments(['a', 'b'], new Set(['a']), cyclic);
    expect(prot.has('a')).toBe(true);
    expect(prot.has('b')).toBe(true);
  });
});
