import { describe, expect, it } from 'vitest';

import { closedMonthsDateError, compensationOpenFrom } from './compensationDates';
import { COMPENSATION_FILES_MAX, validateCompensationFiles } from './compensationFiles';

describe('«Компенсация аренды»: открытый период (миграция 380) — как сервер', () => {
  it('11-е и позже — текущий месяц; по 10-е — ещё прошлый; январь — декабрь прошлого года', () => {
    expect(compensationOpenFrom('2026-11-26')).toBe('2026-11-01');
    expect(compensationOpenFrom('2026-12-10')).toBe('2026-11-01');
    expect(compensationOpenFrom('2026-12-11')).toBe('2026-12-01');
    expect(compensationOpenFrom('2027-01-03')).toBe('2026-12-01');
  });

  it('текст ошибки — те же слова, что у сервера', () => {
    expect(closedMonthsDateError('приостановки', '2026-11-01'))
      .toBe('Месяцы до 01.11.2026 закрыты — компенсация за них уже рассчитана: дата приостановки — не раньше 01.11.2026');
  });
});

describe('файлы компенсации: проверка до отправки', () => {
  const file = (name: string, size = 10) => new File([new Uint8Array(size)], name);

  it('PDF/JPG/DOCX — да; exe, пустой — нет; не больше 20 с прикреплёнными', () => {
    expect(validateCompensationFiles([file('договор.pdf'), file('паспорт.JPG')], 0)).toBeNull();
    expect(validateCompensationFiles([file('вирус.exe')], 0)).toContain('можно PDF');
    expect(validateCompensationFiles([file('пустой.pdf', 0)], 0)).toBe('Файл «пустой.pdf» пустой');
    expect(validateCompensationFiles([file('a.pdf')], COMPENSATION_FILES_MAX))
      .toBe('У сотрудника не больше 20 файлов компенсации');
  });
});
