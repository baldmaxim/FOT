import { describe, expect, it } from 'vitest';

import type { ITimesheetObjectsSummaryBrigade, ITimesheetObjectsSummaryObject } from '../types/timesheet';
import {
  brigadeHourRate,
  exclusionText,
  filterObjectsSummary,
  formatCountedHours,
  objectHourRate,
  objectHourRateTitle,
  rateCoverageNote,
} from './brigadeObjectsSummary';

const NBSP = '\u00A0';

const brigade = (over: Partial<ITimesheetObjectsSummaryBrigade> & Pick<ITimesheetObjectsSummaryBrigade, 'name'>): ITimesheetObjectsSummaryBrigade => ({
  department_id: over.name,
  state: 'fixed',
  output_amount: null,
  in_rate: false,
  exclusion: 'no_output',
  people: 0,
  hours: 0,
  counted_minutes: 0,
  members: [],
  ...over,
});

// Октябрь 2026, ЖК Дом 56 (прод): выработку внесла одна бригада из четырёх.
const DOM56: ITimesheetObjectsSummaryObject = {
  object_key: '484ff35d-6518-472d-ad6d-e2cb6cb1c4ce',
  object_name: 'ЖК Дом 56',
  output_total: '300000.00',
  output_in_rate: '300000.00',
  rated_minutes: 732452,
  counted_minutes: 1702440,
  hours: 29956,
  people: 116,
  brigades_in_rate: 1,
  brigades: [
    brigade({ name: 'бр.Зиякулов К.Э.', counted_minutes: 684425, people: 42, members: null }),
    brigade({
      name: 'бр.Менгбоев Г.И.', output_amount: '300000.00', in_rate: true, exclusion: null, counted_minutes: 732452, people: 2,
      members: [
        { employee_id: 1, full_name: 'Ахмедов Бахтиёр', hours: 200, counted_minutes: 11400 },
        { employee_id: 2, full_name: 'Каримов Олим', hours: 180, counted_minutes: 10200 },
      ],
    }),
  ],
};

describe('стоимость часа — только по бригадам, внёсшим выработку на объект', () => {
  it('ЖК Дом 56, октябрь: 300 000 ÷ 12 207,53 ч бр.Менгбоева = 24,57 ₽/ч (все бригады дали бы 10,57)', () => {
    expect(objectHourRate(DOM56)).toBe('24.57');
    expect(objectHourRateTitle(DOM56)).toBe(`300${NBSP}000,00 ÷ 12207,53 учтённых ч (732452 мин)`);
    expect(rateCoverageNote(DOM56)).toBe('по 1 из 2 бригад');
  });

  it('ни одна бригада не вошла — «Часа» нет; вошли все — без пометки', () => {
    expect(objectHourRate({ ...DOM56, output_in_rate: null, rated_minutes: 0, brigades_in_rate: 0 })).toBeNull();
    expect(rateCoverageNote({ ...DOM56, brigades_in_rate: 0 })).toBeNull();
    expect(rateCoverageNote({ ...DOM56, brigades_in_rate: 2 })).toBeNull();
  });

  it('«из 21 бригады», «из 11 бригад»', () => {
    const many = (count: number) => ({ ...DOM56, brigades: Array.from({ length: count }, (_, i) => brigade({ name: `б${i}` })) });
    expect(rateCoverageNote(many(21))).toBe('по 1 из 21 бригады');
    expect(rateCoverageNote(many(11))).toBe('по 1 из 11 бригад');
  });

  it('у бригады: вошла — её ₽/ч; не вошла — причина, без ₽/ч', () => {
    expect(brigadeHourRate(DOM56.brigades[1])).toBe('24.57');
    expect(brigadeHourRate(DOM56.brigades[0])).toBeNull();
    expect(exclusionText(DOM56.brigades[0])).toBe('выработка не внесена');
    expect(exclusionText(DOM56.brigades[1])).toBeNull();
    expect(exclusionText(brigade({ name: 'б', exclusion: 'by_brigade' }))).toBe('выработка одной суммой на бригаду');
  });

  it('учтённые часы — из минут, с разрядами', () => {
    expect(formatCountedHours(732452)).toBe(`12${NBSP}207,53`);
    expect(formatCountedHours(0)).toBe('0');
  });
});

describe('поиск по объекту, бригаде или ФИО', () => {
  const WAVE: ITimesheetObjectsSummaryObject = { ...DOM56, object_key: 'wave', object_name: 'ЖК Wave', brigades: [DOM56.brigades[1]] };
  const OBJECTS = [DOM56, WAVE];

  it('пусто — все объекты целиком', () => {
    expect(filterObjectsSummary(OBJECTS, '  ').map(view => [view.object.object_name, view.matchedInside])).toEqual([
      ['ЖК Дом 56', false], ['ЖК Wave', false],
    ]);
  });

  it('имя объекта — объект целиком, не раскрыт', () => {
    const [view] = filterObjectsSummary(OBJECTS, 'дом 56');
    expect(view.object.object_name).toBe('ЖК Дом 56');
    expect(view.brigades).toHaveLength(2);
    expect(view.matchedInside).toBe(false);
  });

  it('ФИО — объекты с этим человеком, раскрыты, в бригаде только он; скрытые бригады не ищутся', () => {
    const views = filterObjectsSummary(OBJECTS, 'каримов');
    expect(views.map(view => view.object.object_name)).toEqual(['ЖК Дом 56', 'ЖК Wave']);
    expect(views[0].matchedInside).toBe(true);
    expect(views[0].brigades).toHaveLength(1);
    expect(views[0].brigades[0].members?.map(member => member.full_name)).toEqual(['Каримов Олим']);
  });

  it('ё = е и опечатка — как у поиска ФИО; название бригады — бригада целиком', () => {
    expect(filterObjectsSummary(OBJECTS, 'бахтиер')[0].brigades[0].members).toHaveLength(1);
    expect(filterObjectsSummary(OBJECTS, 'Каримав')[0].brigades[0].members?.[0].full_name).toBe('Каримов Олим');
    const [byBrigade] = filterObjectsSummary(OBJECTS, 'зиякулов');
    expect(byBrigade.brigades.map(item => item.name)).toEqual(['бр.Зиякулов К.Э.']);
  });

  it('ничего не нашлось — пусто', () => {
    expect(filterObjectsSummary(OBJECTS, 'Метрополия')).toEqual([]);
  });
});
