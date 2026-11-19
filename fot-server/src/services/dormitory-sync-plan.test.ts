import { describe, expect, it } from 'vitest';

import { planDormitorySync, type ISyncEmployee, type ISyncOpenStay } from './dormitory-sync-plan.js';

// Загрузка общежитий по файлу 1С на 19.11.2026: даты — решения пользователя; сентябрь–октябрь не трогаются;
// повтор на обновлённой базе — пустой план.

const FILE_DATE = '2026-11-19';
const employee = (id: number, over: Partial<ISyncEmployee> = {}): ISyncEmployee => ({
  id, fullName: `Сотрудник ${id}`, employmentStatus: 'active', hireDate: '2024-01-10', dismissalDate: null, ...over,
});
const stay = (id: number, employeeId: number, address: string, checkIn = '2026-09-01'): ISyncOpenStay => ({
  id, employeeId, address, checkIn, checkOut: null,
});

describe('общежития по файлу 1С', () => {
  const employees = new Map<number, ISyncEmployee>([
    [1, employee(1)],
    [2, employee(2)],
    [3, employee(3, { hireDate: '2026-11-05' })],
    [4, employee(4, { hireDate: '2026-10-29' })],
    [5, employee(5, { employmentStatus: 'fired', dismissalDate: '2026-11-02' })],
    [6, employee(6, { dismissalDate: FILE_DATE })],
    [7, employee(7)],
  ]);
  const file = [
    { employeeId: 1, fullName: 'Баратов', address: 'Общ. Верхнелихоборская 6' },
    { employeeId: 2, fullName: 'Алимов', address: 'Общ. Мал.Почтовая 2\\2' },
    { employeeId: 3, fullName: 'Вахобов', address: 'Общ. Мал.Почтовая 2\\2' },
    { employeeId: 4, fullName: 'Абдурахмонов', address: 'Общ. Мал.Почтовая 2\\2' },
  ];
  const open = [
    stay(10, 1, 'общ. верхнелихоборская 6'),
    stay(11, 2, 'Общ. Нагатинская 34'),
    stay(12, 5, 'Общ. Свободы 35'),
    stay(13, 6, 'Общ. Мал.Почтовая 2\\2'),
    stay(14, 7, 'Общ. Нагатинская 34'),
  ];

  it('совпадает / переселить / заселить (принят в ноябре — с даты приёма) / выселить по правилам дат', () => {
    const plan = planDormitorySync(file, employees, open, FILE_DATE);
    expect(plan.same).toBe(1);
    expect(plan.operations).toEqual([
      { kind: 'move', employeeId: 2, fullName: 'Алимов', stayId: 11, from: 'Общ. Нагатинская 34', to: 'Общ. Мал.Почтовая 2\\2',
        date: FILE_DATE, stayCheckIn: '2026-09-01', stayCheckOut: null },
      { kind: 'add', employeeId: 3, fullName: 'Вахобов', address: 'Общ. Мал.Почтовая 2\\2', checkIn: '2026-11-05' },
      // Принят 29.10 — раньше месяца файла: с даты файла (октябрь не трогаем).
      { kind: 'add', employeeId: 4, fullName: 'Абдурахмонов', address: 'Общ. Мал.Почтовая 2\\2', checkIn: FILE_DATE },
      { kind: 'close', employeeId: 5, fullName: 'Сотрудник 5', stayId: 12, address: 'Общ. Свободы 35', checkOut: '2026-11-03',
        stayCheckIn: '2026-09-01', reason: 'dismissed' },
      { kind: 'close', employeeId: 6, fullName: 'Сотрудник 6', stayId: 13, address: 'Общ. Мал.Почтовая 2\\2', checkOut: FILE_DATE,
        stayCheckIn: '2026-09-01', reason: 'dismissed_on_file_date' },
      { kind: 'close', employeeId: 7, fullName: 'Сотрудник 7', stayId: 14, address: 'Общ. Нагатинская 34', checkOut: FILE_DATE,
        stayCheckIn: '2026-09-01', reason: 'not_in_file' },
    ]);
  });

  it('повтор на обновлённой базе — пустой план', () => {
    const after = [
      stay(10, 1, 'Общ. Верхнелихоборская 6'),
      stay(20, 2, 'Общ. Мал.Почтовая 2\\2', FILE_DATE),
      stay(21, 3, 'Общ. Мал.Почтовая 2\\2', '2026-11-05'),
      stay(22, 4, 'Общ. Мал.Почтовая 2\\2', FILE_DATE),
    ];
    expect(planDormitorySync(file, employees, after, FILE_DATE)).toEqual({ operations: [], same: 4 });
  });

  it('стоп: дважды в файле, два открытых общежития, выезд в закрытый месяц', () => {
    expect(() => planDormitorySync([...file, file[0]], employees, open, FILE_DATE)).toThrow(/дважды/);
    expect(() => planDormitorySync(file, employees, [...open, stay(15, 1, 'Общ. Свободы 35')], FILE_DATE)).toThrow(/Два открытых/);
    const october = new Map(employees).set(5, employee(5, { employmentStatus: 'fired', dismissalDate: '2026-10-20' }));
    expect(() => planDormitorySync(file, october, open, FILE_DATE)).toThrow(/закрытые месяцы/);
  });
});
