import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { evaluateOrphanDepartmentDeactivationSafety } from './sigur-sync-structure.service.js';

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
