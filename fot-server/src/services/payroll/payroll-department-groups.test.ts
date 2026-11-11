import { describe, expect, it } from 'vitest';

import { isItrPositionName, payrollDepartmentGroupIds, payrollGroupFilterSql } from './payroll-department-groups.js';

// Структура как на проде: технический корень «Объект» → СУ-10 и СМ (фиксированные id), бригады внутри компаний.
const TECH = 'tech';
const SU10 = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const SM = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';
const DEPARTMENTS = [
  { id: TECH, parent_id: null, name: 'Объект', kind: 'object' },
  { id: SU10, parent_id: TECH, name: '(СУ-10) ООО СУ-10', kind: 'department' },
  { id: 'build', parent_id: SU10, name: 'Департамент строительства', kind: 'department' },
  { id: 'linia', parent_id: 'build', name: 'ЛИНИЯ', kind: 'department' },
  { id: 'linia-site', parent_id: 'linia', name: 'Участок 1', kind: 'department' },
  { id: 'obshchestroy', parent_id: 'build', name: ' линия-общестрой ', kind: 'department' },
  { id: 'brigades', parent_id: 'build', name: 'Бригады', kind: 'department' },
  { id: 'brigade-1', parent_id: 'brigades', name: 'бр.Иванов', kind: 'brigade' },
  { id: 'guarantee', parent_id: SU10, name: 'Гарантийный отдел', kind: 'department' },
  { id: 'finance', parent_id: SU10, name: 'Финансовый департамент', kind: 'department' },
  { id: SM, parent_id: TECH, name: '(СМ) Служба Механизации', kind: 'department' },
  { id: 'sm-gpm', parent_id: SM, name: 'ГПМ', kind: 'department' },
  { id: 'sm-brigade', parent_id: SM, name: 'бр.Механики', kind: 'brigade' },
  { id: 'contractors', parent_id: TECH, name: 'Подрядные организации', kind: 'department' },
  { id: 'contractor-co', parent_id: 'contractors', name: 'ООО Подрядчик', kind: 'department' },
];

describe('payrollDepartmentGroupIds', () => {
  const groups = payrollDepartmentGroupIds(DEPARTMENTS);

  it('ИТР — ЛИНИЯ, ЛИНИЯ-Общестрой с подотделами и остальные отделы СУ-10, кроме бригад', () => {
    expect(groups.itr.sort()).toEqual([SU10, 'build', 'finance', 'guarantee', 'linia', 'linia-site', 'obshchestroy'].sort());
  });

  it('Рабочие — все бригады, СУ-10 и СМ', () => {
    expect(groups.worker.sort()).toEqual(['brigade-1', 'brigades', 'sm-brigade']);
  });

  it('по должности — отделы СМ без бригад, вместе с самим узлом СМ', () => {
    expect(groups.byPosition.sort()).toEqual([SM, 'sm-gpm'].sort());
  });

  it('подрядчики и корень — нигде', () => {
    const all = new Set([...groups.itr, ...groups.worker, ...groups.byPosition]);
    for (const id of ['contractors', 'contractor-co', TECH]) expect(all.has(id)).toBe(false);
  });

  it('списки не пересекаются', () => {
    const ids = [...groups.itr, ...groups.worker, ...groups.byPosition];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('isItrPositionName — должности СМ с прода', () => {
  it.each([
    'Начальник', 'Начальник  отдела ГПМ', 'Начальник механического цеха', 'Главный механик', 'Главный бухгалтер',
    'Заместитель начальника ОАТ по эксплуатации', 'заместитель главного бухгалтера', 'Руководитель IT-проектов',
    'Руководитель сервисной группы', 'инженер', 'инженер ПТО', 'Инженер - конструктор', 'Сервисный инженер', 'механик',
    'Техник', 'Техник ГПМ', 'Мастер', 'мастер ФД', 'Заведующий складом', 'Специалист по промышленной безопасности подъемных сооружений',
    'диспетчер', 'старший бухгалтер', 'экономист', 'НАЧАЛЬНИК ЦЕХА', 'Ведущий менеджер', 'Технический директор',
    // Специалисты и служащие из справочника должностей.
    'прораб СМ', 'Производитель работ (прораб) (в строительстве)', 'Старший геодезист', 'Энергетик', 'Юрисконсульт',
    'Инженер-программист', 'системный администратор', 'Финансист-аналитик', 'секретарь', 'Старшая табельщица',
    // Опечатки справочника должностей.
    'Руеоводитель отдела', 'специналист ОК', 'системный администатор',
    // Сокращения из справочника должностей.
    'Нач.участка', 'зав.складом', 'Инж.ПТО', 'Ст.инж.ПТО', 'Ст.диспетчер', 'зам.начальника цеха', 'Зам.генерального директора',
  ])('«%s» — ИТР', name => {
    expect(isItrPositionName(name)).toBe(true);
  });

  it.each([
    'Машинист погрузчика', 'Машинист крана автомобильного', 'Слесарь', 'Автослесарь', 'Слесарь-сборщик', 'Водитель',
    'Водитель КМУ', 'персональный водитель', 'Сварщик', 'Электрогазосварщик', 'Электрослесарь', 'Электрик',
    'Бригадир', 'Бригадир-Электрик', 'Звеньевой комплектовщик', 'Стропальщик', 'Подсобный рабочий',
    'Оператор подъемника', 'Помощник оператора бурения', 'Маляр', 'Повар', 'Уборщик производственных и служебных помещений',
    'Электромеханик', 'Электромеханик по лифтам', 'Механизатор', 'Замерщик', 'Звеньевой электриков', 'кладовщик',
    'Монтажник', 'Штукатур', 'Рабочий', '', '   ',
  ])('«%s» — Рабочие', name => {
    expect(isItrPositionName(name)).toBe(false);
  });

  it('без должности — Рабочие', () => {
    expect(isItrPositionName(null)).toBe(false);
    expect(isItrPositionName(undefined)).toBe(false);
  });
});

describe('payrollGroupFilterSql', () => {
  const filter = { departmentIds: ['d'], byPositionDepartmentIds: ['sm'], itrPositionNames: ['Начальник'] };

  it('ИТР — отделы группы или СМ с должностью ИТР; параметры дописываются в конец', () => {
    const params: unknown[] = ['x'];
    expect(payrollGroupFilterSql({ group: 'itr', ...filter }, params)).toBe(
      '(department_id = ANY($2::uuid[]) OR (department_id = ANY($3::uuid[]) AND position_name = ANY($4::text[])))',
    );
    expect(params).toEqual(['x', ['d'], ['sm'], ['Начальник']]);
  });

  it('Рабочие — отделы группы или СМ без должности ИТР (и без должности вовсе)', () => {
    const params: unknown[] = [];
    expect(payrollGroupFilterSql({ group: 'worker', ...filter }, params)).toBe(
      '(department_id = ANY($1::uuid[]) OR (department_id = ANY($2::uuid[])'
      + ' AND (position_name IS NULL OR position_name <> ALL($3::text[]))))',
    );
  });
});
