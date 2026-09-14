import { describe, it, expect } from 'vitest';
import {
  buildExportSections,
  buildInDepartmentScopeOnlySql,
  buildInDepartmentScopeSql,
  countSectionRows,
  createDepartmentPlacer,
  effectiveDepartmentSql,
  listSectionDepartmentIds,
  placeEmployee,
  type IExportDepartmentRow,
  type IExportEmployeeRow,
  type IExportSection,
} from './employees-export.service.js';

const SM_ROOT_ID = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';
const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';

const dept = (
  id: string,
  name: string,
  parent_id: string | null,
  kind: string = 'department',
): IExportDepartmentRow => ({ id, name, parent_id, kind });

/** Структура как в проде: «Объект» → компании/папки → отделы. */
const DEPARTMENTS: IExportDepartmentRow[] = [
  dept('root', 'Объект', null, 'object'),
  dept(SM_ROOT_ID, '(СМ) Служба Механизации', 'root'),
  dept('sm-auto', 'Отдел автотехники', SM_ROOT_ID),
  dept(SU10_ROOT_ID, '(СУ-10) ООО СУ-10', 'root'),
  dept('su-vent', 'Отдел вентиляции', SU10_ROOT_ID),
  dept('su-vent-site', 'Участок 1', 'su-vent'),
  dept('su-decret', 'Декрет', SU10_ROOT_ID),
  dept('su-site', 'Строительный участок', SU10_ROOT_ID),
  dept('brigades', 'Бригады', 'su-site'),
  dept('br-ivanov', 'бр.Иванов', 'brigades', 'brigade'),
  dept('br-petrov', 'бр.Петров', 'su-vent', 'brigade'),
  dept('ctr-brigade', 'бр.Подрядная', 'ctr-alfa', 'brigade'),
  dept('contractors', 'Подрядные организации', 'root'),
  dept('ctr-alfa', 'ООО Альфа', 'contractors'),
  dept('fired', 'Уволенные', 'root'),
  dept('test', 'test', 'root'),
];

const emp = (
  id: number,
  full_name: string,
  effective_department_id: string | null,
  overrides: Partial<IExportEmployeeRow> = {},
): IExportEmployeeRow => ({
  id,
  full_name,
  employment_status: 'active',
  birth_date: null,
  hire_date: null,
  position_name: null,
  effective_department_id,
  in_department_scope: true,
  ...overrides,
});

const build = (
  employees: IExportEmployeeRow[],
  mainObjectByEmployee = new Map<number, string>(),
  departments = DEPARTMENTS,
): IExportSection[] => buildExportSections({ employees, departments, mainObjectByEmployee });

const section = (sections: IExportSection[], key: IExportSection['key']): IExportSection | undefined =>
  sections.find(item => item.key === key);

describe('buildExportSections', () => {
  it('раскладывает по разделам в фиксированном порядке и пропускает пустые', () => {
    const sections = build([
      emp(1, 'Подрядчиков П.', 'ctr-alfa'),
      emp(2, 'Вентиляцин В.', 'su-vent'),
      emp(3, 'Бригадин Б.', 'br-ivanov'),
      emp(4, 'Тестов Т.', 'test'),
    ]);

    expect(sections.map(item => item.key)).toEqual(['su10', 'brigades', 'contractors', 'other']);
    expect(sections.map(item => item.tableName))
      .toEqual(['Employees_SU10', 'Employees_Brigades', 'Employees_Contractors', 'Employees_Other']);
  });

  it('бригады СУ-10 — отдельный раздел: и под папкой «Бригады», и вложенные в отдел', () => {
    const sections = build([
      emp(1, 'Иванов И.', 'br-ivanov'),
      emp(2, 'Петров П.', 'br-petrov'),
      emp(3, 'Участков У.', 'su-site'),
    ]);

    expect(section(sections, 'brigades')?.rows.map(row => [row.fullName, row.departmentPath])).toEqual([
      ['Иванов И.', 'бр.Иванов'],
      ['Петров П.', 'Отдел вентиляции / бр.Петров'],
    ]);
    expect(section(sections, 'su10')?.rows.map(row => row.fullName)).toEqual(['Участков У.']);
  });

  it('бригада внутри подрядной организации остаётся в «Подрядных»', () => {
    const sections = build([emp(1, 'Подрядный П.', 'ctr-brigade')]);

    expect(sections.map(item => item.key)).toEqual(['contractors']);
    expect(sections[0].rows[0].departmentPath).toBe('ООО Альфа / бр.Подрядная');
  });

  it('путь подразделения — без названия компании в известных разделах, с корнем в «Прочих»', () => {
    const sections = build([
      emp(1, 'Участков У.', 'su-vent-site'),
      emp(2, 'Механиков М.', 'sm-auto'),
      emp(3, 'Компанейцев К.', SU10_ROOT_ID),
      emp(4, 'Тестов Т.', 'test'),
    ]);

    expect(section(sections, 'su10')?.rows.map(row => [row.fullName, row.departmentPath])).toEqual([
      ['Компанейцев К.', ''],
      ['Участков У.', 'Отдел вентиляции / Участок 1'],
    ]);
    expect(section(sections, 'sm')?.rows[0].departmentPath).toBe('Отдел автотехники');
    expect(section(sections, 'other')?.rows[0].departmentPath).toBe('test');
  });

  it('уволенный попадает в раздел отдела до увольнения с признаком «Уволен»', () => {
    const sections = build([
      emp(1, 'Уволенный У.', 'su-vent', { employment_status: 'fired' }),
    ]);

    expect(sections.map(item => item.key)).toEqual(['su10']);
    expect(sections[0].rows[0]).toMatchObject({ sign: 'Уволен', departmentPath: 'Отдел вентиляции' });
  });

  it('уволенный без события увольнения (отдел «Уволенные») уходит в «Прочие»', () => {
    const sections = build([emp(1, 'Уволенный У.', 'fired', { employment_status: 'fired' })]);

    expect(sections.map(item => item.key)).toEqual(['other']);
    expect(sections[0].rows[0]).toMatchObject({ sign: 'Уволен', departmentPath: 'Уволенные' });
  });

  it('приоритет признака: Уволен > Декрет > Работает', () => {
    const sections = build([
      emp(1, 'Декретная Д.', 'su-decret'),
      emp(2, 'Уволенная из декрета У.', 'su-decret', { employment_status: 'fired' }),
      emp(3, 'Работник Р.', 'su-vent'),
    ]);

    const signs = Object.fromEntries(section(sections, 'su10')!.rows.map(row => [row.employeeId, row.sign]));
    expect(signs).toEqual({ 1: 'Декрет', 2: 'Уволен', 3: 'Работает' });
  });

  it('«Декрет» распознаётся и на вложенном отделе', () => {
    const departments = [...DEPARTMENTS, dept('decret-child', 'Группа 1', 'su-decret')];
    const sections = build([emp(1, 'Декретная Д.', 'decret-child')], new Map(), departments);

    expect(sections[0].rows[0].sign).toBe('Декрет');
  });

  it('прямой подчинённый вне скоупа отделов — «Прочие» без пути', () => {
    const sections = build([
      emp(1, 'Свой С.', 'su-vent'),
      emp(2, 'Подчинённый П.', 'ctr-alfa', { in_department_scope: false }),
    ]);

    expect(sections.map(item => item.key)).toEqual(['su10', 'other']);
    expect(section(sections, 'other')?.rows[0]).toMatchObject({ employeeId: 2, departmentPath: '' });
  });

  it('без отдела и с неизвестным отделом — «Прочие» без пути', () => {
    const sections = build([emp(1, 'Ничейный Н.', null), emp(2, 'Потерянный П.', 'deleted-dept')]);

    expect(sections).toHaveLength(1);
    expect(sections[0].key).toBe('other');
    expect(sections[0].rows.map(row => row.departmentPath)).toEqual(['', '']);
  });

  it('подставляет объект, должность и даты; нет объекта — пустая строка', () => {
    const sections = build(
      [
        emp(1, 'Первый П.', 'su-vent', { position_name: 'Монтажник', birth_date: '1990-03-05', hire_date: '2024-01-15' }),
        emp(2, 'Юрьев Ю.', 'su-vent'),
      ],
      new Map([[1, 'ЖК Север']]),
    );

    expect(sections[0].rows).toEqual([
      {
        employeeId: 1, fullName: 'Первый П.', departmentPath: 'Отдел вентиляции', positionName: 'Монтажник',
        birthDate: '1990-03-05', hireDate: '2024-01-15', objectName: 'ЖК Север', sign: 'Работает', costItem: '',
      },
      {
        employeeId: 2, fullName: 'Юрьев Ю.', departmentPath: 'Отдел вентиляции', positionName: '',
        birthDate: null, hireDate: null, objectName: '', sign: 'Работает', costItem: '',
      },
    ]);
  });

  it('сортирует по пути подразделения, затем по ФИО', () => {
    const sections = build([
      emp(1, 'Яковлев Я.', 'su-vent'),
      emp(2, 'Абрамов А.', 'su-vent-site'),
      emp(3, 'Ёлкин Ё.', 'su-vent'),
    ]);

    expect(sections[0].rows.map(row => row.fullName)).toEqual(['Ёлкин Ё.', 'Яковлев Я.', 'Абрамов А.']);
  });

  it('цикл parent_id не вешает сборку и не теряет сотрудников', () => {
    const departments = [dept('a', 'Отдел А', 'b'), dept('b', 'Отдел Б', 'a')];
    const sections = build([emp(1, 'Петров П.', 'a'), emp(2, 'Сидоров С.', 'b')], new Map(), departments);

    expect(countSectionRows(sections)).toBe(2);
    expect(sections.map(item => item.key)).toEqual(['other']);
  });

  it('каждый сотрудник появляется ровно один раз', () => {
    const employees = [
      emp(1, 'А', 'sm-auto'), emp(2, 'Б', 'su-vent'), emp(3, 'В', 'br-ivanov'),
      emp(4, 'Г', 'ctr-alfa'), emp(5, 'Д', null), emp(6, 'Е', 'su-decret', { employment_status: 'fired' }),
    ];
    const ids = build(employees).flatMap(item => item.rows.map(row => row.employeeId));

    expect(ids.sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('пустой список — пустой результат', () => {
    expect(build([])).toEqual([]);
  });
});

describe('статья затрат в строках выгрузки', () => {
  it('подставляется из costItemByEmployee, нет записи — пустая строка', () => {
    const sections = buildExportSections({
      employees: [emp(1, 'Первый П.', 'su-vent'), emp(2, 'Второй В.', 'su-vent')],
      departments: DEPARTMENTS,
      mainObjectByEmployee: new Map(),
      costItemByEmployee: new Map([[1, 'СКУД (ЖК Север)']]),
    });
    const byId = Object.fromEntries(sections[0].rows.map(row => [row.employeeId, row.costItem]));
    expect(byId).toEqual({ 1: 'СКУД (ЖК Север)', 2: '' });
  });
});

describe('listSectionDepartmentIds / placeEmployee — те же правила, что у листов', () => {
  const WITH_SUPPORT = [
    ...DEPARTMENTS,
    dept('su-contractor-support', 'Отдел по сопровождению подрядчиков', SU10_ROOT_ID),
    dept('su-closed', 'Закрытый отдел', SU10_ROOT_ID),
  ];

  it('su10 без бригад; бригады СУ-10 — в brigades; подрядчики — только по верхнему узлу', () => {
    const su10 = listSectionDepartmentIds(WITH_SUPPORT, 'su10');
    expect(su10).toEqual(expect.arrayContaining([SU10_ROOT_ID, 'su-vent', 'su-vent-site', 'su-decret', 'su-site', 'su-contractor-support', 'su-closed']));
    expect(su10).not.toContain('brigades');
    expect(su10).not.toContain('br-ivanov');
    expect(su10).not.toContain('br-petrov');

    expect(listSectionDepartmentIds(WITH_SUPPORT, 'brigades').sort()).toEqual(['br-ivanov', 'br-petrov', 'brigades'].sort());
    expect(listSectionDepartmentIds(WITH_SUPPORT, 'contractors').sort()).toEqual(['contractors', 'ctr-alfa', 'ctr-brigade'].sort());
    expect(listSectionDepartmentIds(WITH_SUPPORT, 'sm').sort()).toEqual([SM_ROOT_ID, 'sm-auto'].sort());
  });

  it('разделы фильтра и листы выгрузки совпадают для каждого отдела', () => {
    const employees = WITH_SUPPORT.map((item, index) => emp(index + 1, `Сотрудник ${index}`, item.id));
    const sections = buildExportSections({ employees, departments: WITH_SUPPORT, mainObjectByEmployee: new Map() });
    for (const key of ['sm', 'su10', 'brigades', 'contractors'] as const) {
      const fromSheets = (section(sections, key)?.rows ?? []).map(row => employees[row.employeeId - 1].effective_department_id).sort();
      expect(listSectionDepartmentIds(WITH_SUPPORT, key).sort()).toEqual(fromSheets);
    }
  });

  it('прямой подчинённый вне скоупа и неизвестный отдел — other', () => {
    const placer = createDepartmentPlacer(WITH_SUPPORT);
    expect(placeEmployee(placer, 'su-vent', true).section).toBe('su10');
    expect(placeEmployee(placer, 'su-vent', false).section).toBe('other');
    expect(placeEmployee(placer, 'deleted', true).section).toBe('other');
    expect(placeEmployee(placer, null, true).section).toBe('other');
  });
});

describe('SQL скоупа и отдела для раздела', () => {
  it('effectiveDepartmentSql: последнее неотменённое событие с заполненным отделом, иначе текущий', () => {
    const sql = effectiveDepartmentSql('e');
    expect(sql).toContain(`e.employment_status = 'fired'`);
    expect(sql).toContain('d.from_department_id IS NOT NULL');
    expect(sql).toContain('d.cancelled IS NOT TRUE');
    expect(sql).toContain('ORDER BY d.created_at DESC, d.id DESC');
    expect(sql).toContain('e.org_department_id)');
  });

  it('buildInDepartmentScopeOnlySql не добавляет неиспользуемых параметров', () => {
    const params: unknown[] = [];
    const scope = { mode: 'departments' as const, departmentIds: ['d1'], directEmployeeIds: [5], selfEmployeeId: null };
    expect(buildInDepartmentScopeOnlySql(scope, 'X', params)).toBe('(X IS NOT NULL AND X = ANY($1::uuid[]))');
    expect(params).toEqual([['d1']]);

    const none: unknown[] = [];
    expect(buildInDepartmentScopeOnlySql({ ...scope, mode: 'all' }, 'X', none)).toBe('TRUE');
    expect(buildInDepartmentScopeOnlySql({ ...scope, mode: 'employees' }, 'X', none)).toBe('TRUE');
    expect(buildInDepartmentScopeOnlySql({ ...scope, mode: 'none' }, 'X', none)).toBe('FALSE');
    expect(none).toEqual([]);
  });

  it('buildInDepartmentScopeSql: отделы скоупа или прямые подчинённые', () => {
    const params: unknown[] = ['p1'];
    const result = buildInDepartmentScopeSql(
      { mode: 'departments', departmentIds: ['d1'], directEmployeeIds: [5], selfEmployeeId: null },
      { effectiveDepartmentExpr: 'b.dept', employeeIdExpr: 'b.id' },
      params,
    );
    expect(result.inDepartmentScope).toBe('(b.dept IS NOT NULL AND b.dept = ANY($2::uuid[]))');
    expect(result.scopeCondition).toBe('((b.dept IS NOT NULL AND b.dept = ANY($2::uuid[])) OR b.id = ANY($3::int[]))');
    expect(params).toEqual(['p1', ['d1'], [5]]);
  });
});
