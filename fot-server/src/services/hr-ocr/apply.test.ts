import { beforeAll, describe, expect, it } from 'vitest';

process.env.HR_FIELD_ENCRYPTION_KEYS ||= `v1:${'a'.repeat(64)}`;
process.env.HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION ||= 'v1';
process.env.HR_FIELD_HASH_PEPPER ||= 'pepper-pepper-pepper-pepper-pepper-32';

type Apply = typeof import('./apply.js');
let a: Apply;

const citizenships = [
  { id: 'ru', name: 'Россия', iso_code: 'RUS', synonyms: ['рф'] },
  { id: 'tj', name: 'Таджикистан', iso_code: 'TJK', synonyms: ['точикистон'] },
];

beforeAll(async () => {
  a = await import('./apply.js');
});

describe('hr-ocr apply: патч из нормализованного', () => {
  it('паспорт РФ → форматированные поля', () => {
    const patch = a.buildProfilePatchFromOcr({
      lastName: 'ИВАНОВ', firstName: 'иван', passportSeries: '4510', passportNumber: '123456',
      passportDepartmentCode: '770001', sex: 'M', citizenship: 'RUS', snils: '12345678901', phone: '89101234567',
    }, citizenships);
    expect(patch.last_name).toBe('Иванов');
    expect(patch.first_name).toBe('Иван');
    expect(patch.passport_number).toBe('4510 123456');
    expect(patch.passport_type).toBe('russian');
    expect(patch.passport_department_code).toBe('770-001');
    expect(patch.gender).toBe('male');
    expect(patch.citizenship_id).toBe('ru');
    expect(patch.snils).toBe('123-456-789 01');
    expect(patch.phone).toBe('+7 (910) 123-45-67');
  });

  it('гражданство по синониму / ISO; неизвестное → citizenship_raw', () => {
    expect(a.buildProfilePatchFromOcr({ citizenship: 'ТОЧИКИСТОН' }, citizenships).citizenship_id).toBe('tj');
    expect(a.buildProfilePatchFromOcr({ citizenship: 'TJK' }, citizenships).citizenship_id).toBe('tj');
    expect(a.buildProfilePatchFromOcr({ citizenship: 'MARS' }, citizenships).citizenship_raw).toBe('MARS');
  });

  it('патент и бланк', () => {
    const patch = a.buildProfilePatchFromOcr({ patentNumber: '771234567890', blankNumber: 'пр 1234567' }, citizenships);
    expect(patch.patent_number).toBe('77 №1234567890');
    expect(patch.patent_blank_number).toBe('ПР1234567');
  });
});

describe('hr-ocr apply: план применения', () => {
  it('пустое → автозаполнение, отличающееся → конфликт, равное после нормализации → ничего', () => {
    const plan = a.buildOcrApplyPlan(
      { inn: null, snils: '123-456-789 01', passport_number: '4510 111111', phone: '' },
      { inn: '770123456789', snils: '12345678901', passport_number: '4510 222222', phone: '+7 (910) 123-45-67' },
    );
    expect(plan.autoFill).toEqual({ inn: '770123456789', phone: '+7 (910) 123-45-67' });
    expect(plan.conflicts).toEqual([{ fieldName: 'passport_number', currentValue: '4510 111111', ocrValue: '4510 222222' }]);
  });

  it('skipFields исключает поля', () => {
    const plan = a.buildOcrApplyPlan({ last_name: 'Петров' }, { last_name: 'Иванов', inn: '1' }, { skipFields: ['last_name'] });
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.autoFill).toEqual({ inn: '1' });
  });
});
