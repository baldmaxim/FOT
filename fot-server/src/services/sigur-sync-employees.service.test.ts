import { describe, expect, it } from 'vitest';

import {
  cleanUpdateFieldsForAction,
  decideDeptSyncAction,
  evaluateAutoFireSafety,
  isAncestorDepartment,
  type IDeptSyncFreshState,
} from './sigur-sync-employees.service.js';

describe('evaluateAutoFireSafety', () => {
  it('пропускает обычный fire ниже лимита', () => {
    const r = evaluateAutoFireSafety(2400, 2400, 5);
    expect(r.shouldSkip).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('блокирует fire при усечённой выгрузке Sigur (< 50% активных)', () => {
    const r = evaluateAutoFireSafety(2400, 1000, 50);
    expect(r.shouldSkip).toBe(true);
    expect(r.reason).toContain('looks truncated');
  });

  it('пропускает fire, если выгрузка точно совпадает с активными', () => {
    const r = evaluateAutoFireSafety(2400, 2400, 1);
    expect(r.shouldSkip).toBe(false);
  });

  it('блокирует fire при превышении абсолютного лимита по умолчанию (20)', () => {
    const r = evaluateAutoFireSafety(100, 100, 21);
    expect(r.shouldSkip).toBe(true);
    expect(r.reason).toContain('exceeds limit 20');
  });

  it('пропускает fire ровно на абсолютном лимите', () => {
    const r = evaluateAutoFireSafety(100, 100, 20);
    expect(r.shouldSkip).toBe(false);
  });

  it('повышает лимит до 5% активных, если 5% больше абсолютного', () => {
    // 5% от 1000 = 50, при absoluteLimit=20 итоговый лимит = 50
    const r = evaluateAutoFireSafety(1000, 1000, 45);
    expect(r.shouldSkip).toBe(false);
    expect(r.limit).toBe(50);
  });

  it('блокирует fire при превышении относительного лимита 5%', () => {
    const r = evaluateAutoFireSafety(1000, 1000, 60);
    expect(r.shouldSkip).toBe(true);
    expect(r.reason).toContain('exceeds limit 50');
  });

  it('уважает кастомный absoluteLimit (env SIGUR_AUTOFIRE_MAX)', () => {
    const r = evaluateAutoFireSafety(50, 50, 5, { absoluteLimit: 3 });
    expect(r.shouldSkip).toBe(true);
    expect(r.limit).toBe(Math.max(3, Math.ceil(50 * 0.05)));
  });

  it('truncationRatio 0 отключает проверку усечения', () => {
    const r = evaluateAutoFireSafety(2400, 0, 0, { truncationRatio: 0 });
    expect(r.shouldSkip).toBe(false);
  });

  it('пустая БД (activeWithSigur=0) не падает на проверке усечения', () => {
    const r = evaluateAutoFireSafety(0, 0, 0);
    expect(r.shouldSkip).toBe(false);
  });

  it('воспроизводит инцидент 17.04: fire 12 при ~2400 активных пропускался, теперь блокируется', () => {
    // Активных ~2400, лимит = max(20, ceil(2400*0.05)=120) = 120 → 12 проходит.
    // Здесь воспроизводим именно превышение порога — 130 шт. блокируется.
    const r = evaluateAutoFireSafety(2400, 2400, 130);
    expect(r.shouldSkip).toBe(true);
    expect(r.limit).toBe(120);
  });
});

describe('isAncestorDepartment (guard B′: защита от подъёма к отделу-предку)', () => {
  // Дерево инцидента: su10 → central → {sekr, sekrobj, courier}; other → su10.
  const tree = new Map<string, string | null>([
    ['su10', null],
    ['central', 'su10'],
    ['sekr', 'central'],
    ['sekrobj', 'central'],
    ['courier', 'central'],
    ['other', 'su10'],
  ]);

  it('подъём к корню компании = предок → блокируется (кейс секретариата)', () => {
    expect(isAncestorDepartment('su10', 'sekr', tree)).toBe(true);
    expect(isAncestorDepartment('su10', 'courier', tree)).toBe(true);
  });

  it('подъём к промежуточному родителю = предок → блокируется', () => {
    expect(isAncestorDepartment('central', 'sekr', tree)).toBe(true);
  });

  it('перевод к соседнему отделу (sibling) → разрешён', () => {
    expect(isAncestorDepartment('sekrobj', 'sekr', tree)).toBe(false);
  });

  it('перевод вниз к потомку → разрешён', () => {
    expect(isAncestorDepartment('sekr', 'central', tree)).toBe(false);
  });

  it('тот же отдел / нет текущего → не предок', () => {
    expect(isAncestorDepartment('sekr', 'sekr', tree)).toBe(false);
    expect(isAncestorDepartment('sekr', null, tree)).toBe(false);
    expect(isAncestorDepartment('sekr', undefined, tree)).toBe(false);
  });

  it('цикл в parent_id не зацикливает обход', () => {
    const cyclic = new Map<string, string | null>([['a', 'b'], ['b', 'a']]);
    expect(isAncestorDepartment('x', 'a', cyclic)).toBe(false);
  });
});

// ─── Гонка «увольнение ↔ синк» (кейс Сафарова 1623, 31.07.2026) ───

const ARCHIVE = 'archive-dept';
const BRIGADE = 'brigade-dept';
const TODAY = '2026-07-31';
const TOMORROW = '2026-08-01';

const freshState = (over: Partial<IDeptSyncFreshState> = {}): IDeptSyncFreshState => ({
  org_department_id: BRIGADE,
  employment_status: 'active',
  dismissal_date: null,
  dismissal_apply_started_at: null,
  target_assignments: [],
  ...over,
});

describe('decideDeptSyncAction — решение по смене отдела на фазе сохранения', () => {
  it('гонка-эталон: увольнение применено (fired + claim + назначение D+1) → skip-local-dismissal', () => {
    const fresh = freshState({
      org_department_id: BRIGADE, // stale-снапшот здесь не важен — важны маркеры
      employment_status: 'fired',
      dismissal_date: TODAY,
      dismissal_apply_started_at: '2026-07-31 20:02:47+00',
      target_assignments: [{ effective_from: TOMORROW, effective_to: null }],
    });
    expect(decideDeptSyncAction(fresh, ARCHIVE, true, TODAY)).toBe('skip-local-dismissal');
  });

  it('Sigur перемещён, назначения D+1 ещё нет, но claim установлен (ручное увольнение в окне) → skip', () => {
    const fresh = freshState({ dismissal_apply_started_at: '2026-07-31 20:02:47+00' });
    expect(decideDeptSyncAction(fresh, ARCHIVE, true, TODAY)).toBe('skip-local-dismissal');
  });

  it('активная заявка с будущим dismissal_date → синк не увольняет немедленно', () => {
    const fresh = freshState({ dismissal_date: '2026-08-15' });
    expect(decideDeptSyncAction(fresh, ARCHIVE, true, TODAY)).toBe('skip-local-dismissal');
  });

  it('активный с ПРОСРОЧЕННЫМ dismissal_date < today → skip (владелец — scheduler, дата не подменяется)', () => {
    const fresh = freshState({ dismissal_date: '2026-07-25' });
    expect(decideDeptSyncAction(fresh, ARCHIVE, true, TODAY)).toBe('skip-local-dismissal');
  });

  it('только будущее назначение в архив (без заявки и claim) → skip-local-dismissal', () => {
    const fresh = freshState({
      target_assignments: [{ effective_from: TOMORROW, effective_to: null }],
    });
    expect(decideDeptSyncAction(fresh, ARCHIVE, true, TODAY)).toBe('skip-local-dismissal');
  });

  it('archiveLocalDeptId неважен: увольнение распознаётся по флагу isDismissalDept', () => {
    // Раньше кейс Сафарова уходил в «обычную» ветку из-за несовпавшего локального
    // маппинга архива. Решение обязано опираться на Sigur department ID.
    const fresh = freshState({ dismissal_date: TODAY });
    expect(decideDeptSyncAction(fresh, 'какой-то-локальный-uuid', true, TODAY)).toBe('skip-local-dismissal');
  });

  it('возврат уволенного из архива в бригаду по данным Sigur → skip-fired (реактивации нет)', () => {
    // Инцидент 10–13.08.2026: синк возвращал уволенного в рабочий отдел и снимал fired.
    // Теперь такой возврат возможен только явным rehire со стороны HR.
    const fresh = freshState({
      org_department_id: ARCHIVE,
      employment_status: 'fired',
      dismissal_date: '2026-06-01',
      dismissal_apply_started_at: '2026-06-01 20:02:00+00',
    });
    expect(decideDeptSyncAction(fresh, BRIGADE, false, TODAY)).toBe('skip-fired');
  });

  it('уволенный в архиве без claim и будущих назначений → skip-fired', () => {
    const fresh = freshState({
      org_department_id: ARCHIVE,
      employment_status: 'fired',
      dismissal_date: '2026-06-01',
    });
    expect(decideDeptSyncAction(fresh, ARCHIVE, true, TODAY)).toBe('skip-fired');
  });

  it('уволенный, Sigur отдаёт рабочий отдел → skip-fired, отдел не переносится', () => {
    const fresh = freshState({
      org_department_id: ARCHIVE,
      employment_status: 'fired',
      dismissal_date: TODAY,
    });
    expect(decideDeptSyncAction(fresh, 'other-brigade', false, TODAY)).toBe('skip-fired');
  });

  it('активный сотрудник исходом skip-fired не задевается', () => {
    const fresh = freshState();
    expect(decideDeptSyncAction(fresh, 'other-dept', false, TODAY)).toBe('apply');
  });

  it('обычный перевод (не архив) сотрудника с будущим увольнением → НЕ блокируется', () => {
    const fresh = freshState({ dismissal_date: '2026-08-15' });
    expect(decideDeptSyncAction(fresh, 'other-dept', false, TODAY)).toBe('apply');
  });

  it('внешний перенос в архив без локального увольнения → apply (старое поведение)', () => {
    const fresh = freshState();
    expect(decideDeptSyncAction(fresh, ARCHIVE, true, TODAY)).toBe('apply');
  });

  it('снапшот уже в целевом отделе → noop', () => {
    const fresh = freshState({ org_department_id: 'target' });
    expect(decideDeptSyncAction(fresh, 'target', false, TODAY)).toBe('noop');
  });

  it('назначение в целевой отдел активно сегодня → snapshot-only', () => {
    const fresh = freshState({
      target_assignments: [{ effective_from: TODAY, effective_to: null }],
    });
    expect(decideDeptSyncAction(fresh, 'target', false, TODAY)).toBe('snapshot-only');
  });

  it('назначение в целевой отдел с завтра / через месяц → defer', () => {
    const tomorrow = freshState({ target_assignments: [{ effective_from: TOMORROW, effective_to: null }] });
    expect(decideDeptSyncAction(tomorrow, 'target', false, TODAY)).toBe('defer');

    const nextMonth = freshState({ target_assignments: [{ effective_from: '2026-08-31', effective_to: null }] });
    expect(decideDeptSyncAction(nextMonth, 'target', false, TODAY)).toBe('defer');
  });
});

describe('cleanUpdateFieldsForAction — очистка авто-полей по принятому решению', () => {
  const autoFields = () => ({
    employment_status: 'fired',
    dismissal_date: TODAY,
    excluded_from_timesheet: true,
    excluded_from_timesheet_date: TOMORROW,
    org_department_id: ARCHIVE,
    full_name: 'Иванов Иван',
    tab_number: '123',
  });

  it('skip-local-dismissal: снимает авто-поля увольнения и org_department_id, несвязанные — остаются', () => {
    const fields = autoFields();
    cleanUpdateFieldsForAction(fields, 'skip-local-dismissal', true, 'fired');
    expect(fields).toEqual({ full_name: 'Иванов Иван', tab_number: '123' });
  });

  it('defer: активный сотрудник НЕ помечается уволенным без изменения истории', () => {
    const fields = autoFields();
    cleanUpdateFieldsForAction(fields, 'defer', true, 'active');
    expect(fields).toEqual({ full_name: 'Иванов Иван', tab_number: '123' });
  });

  it('snapshot-only: из полей перехода остаётся только org_department_id, ФИО/таб.номер не трогаются', () => {
    const fields = autoFields();
    cleanUpdateFieldsForAction(fields, 'snapshot-only', true, 'fired');
    expect(fields).toEqual({
      org_department_id: ARCHIVE,
      full_name: 'Иванов Иван',
      tab_number: '123',
    });
  });

  it('apply при fresh=active: авто-поля увольнения сохраняются (настоящее внешнее увольнение)', () => {
    const fields = autoFields();
    cleanUpdateFieldsForAction(fields, 'apply', true, 'active');
    expect(fields.employment_status).toBe('fired');
    expect(fields.dismissal_date).toBe(TODAY);
    // org_department_id снят: историю и снапшот пишет changeDepartment.
    expect(fields.org_department_id).toBeUndefined();
  });

  it('apply при fresh=fired: авто-поля сняты — чужой dismissal_date не затирается сегодняшним', () => {
    const fields = autoFields();
    cleanUpdateFieldsForAction(fields, 'apply', true, 'fired');
    expect(fields.employment_status).toBeUndefined();
    expect(fields.dismissal_date).toBeUndefined();
  });

  it('не-архивный перевод: авто-поля увольнения не трогаются (их и не бывает), org снимается при skip', () => {
    const fields: Record<string, unknown> = { org_department_id: 'other-dept', tab_number: '5' };
    cleanUpdateFieldsForAction(fields, 'defer', false, 'active');
    expect(fields).toEqual({ tab_number: '5' });
  });

  it('skip-fired: снимает отдел, должность и lifecycle-поля даже вне архивного перехода', () => {
    const fields: Record<string, unknown> = {
      ...autoFields(),
      org_department_id: 'brigade-dept',
      position_id: 'position-2',
    };
    cleanUpdateFieldsForAction(fields, 'skip-fired', false, 'fired');
    expect(fields).toEqual({ full_name: 'Иванов Иван', tab_number: '123' });
  });

  it('skip-fired: ФИО и табельный номер уволенного продолжают актуализироваться', () => {
    const fields: Record<string, unknown> = { full_name: 'Петров Пётр', tab_number: '777' };
    cleanUpdateFieldsForAction(fields, 'skip-fired', false, 'fired');
    expect(fields).toEqual({ full_name: 'Петров Пётр', tab_number: '777' });
  });
});
