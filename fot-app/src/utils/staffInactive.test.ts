import { describe, expect, it } from 'vitest';
import { staffInactiveActionFor } from './staffInactive';

describe('staffInactiveActionFor (миграция 381)', () => {
  it('работающий — «Перевести в неактивные»', () => {
    expect(staffInactiveActionFor({ employment_status: 'active', staff_inactive_at: null, inactive_department_name: null })).toBe('deactivate');
  });

  it('переведённый вручную — «Вернуть в активные», и в «Декрете» тоже (снимается только метка)', () => {
    expect(staffInactiveActionFor({ employment_status: 'active', staff_inactive_at: '2026-11-26T09:00:00.000Z', inactive_department_name: null })).toBe('reactivate');
    expect(staffInactiveActionFor({ employment_status: 'active', staff_inactive_at: '2026-11-26T09:00:00.000Z', inactive_department_name: 'Декрет' })).toBe('reactivate');
  });

  it('«Декрет»/«Архив» без метки и уволенный — кнопки нет', () => {
    expect(staffInactiveActionFor({ employment_status: 'active', staff_inactive_at: null, inactive_department_name: 'Архив' })).toBeNull();
    expect(staffInactiveActionFor({ employment_status: 'fired', staff_inactive_at: null, inactive_department_name: null })).toBeNull();
  });
});
