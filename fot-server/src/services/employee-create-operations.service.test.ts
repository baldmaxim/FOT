import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Идемпотентное создание сотрудника: claim операции и поиск «потерянной»
 * карточки Sigur по маркеру операции.
 */

const h = vi.hoisted(() => ({ query: vi.fn(), queryOne: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ query: h.query, queryOne: h.queryOne }));

import {
  buildOperationMarker,
  claimCreateOperation,
  findSigurEmployeeIdByMarker,
  hashCreatePayload,
  OPERATION_MARKER_PREFIX,
} from './employee-create-operations.service.js';

const OPERATION_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hashCreatePayload', () => {
  it('не зависит от порядка ключей', () => {
    const a = hashCreatePayload({ full_name: 'Иванов И.', hire_date: '2026-09-01' });
    const b = hashCreatePayload({ hire_date: '2026-09-01', full_name: 'Иванов И.' });

    expect(a).toBe(b);
  });

  it('меняется при других данных — тот же ключ с другим телом должен отвергаться', () => {
    const a = hashCreatePayload({ full_name: 'Иванов И.', hire_date: '2026-09-01' });
    const b = hashCreatePayload({ full_name: 'Петров П.', hire_date: '2026-09-01' });

    expect(a).not.toBe(b);
  });
});

describe('claimCreateOperation', () => {
  it('первый запрос занимает операцию', async () => {
    h.queryOne.mockResolvedValueOnce({ operation_id: OPERATION_ID, status: 'claimed', payload_hash: 'h' });

    const { isNew } = await claimCreateOperation(OPERATION_ID, 'user-1', 'h');

    expect(isNew).toBe(true);
    expect(h.queryOne).toHaveBeenCalledTimes(1);
  });

  it('повтор (и параллельный запрос) получает существующую операцию, а не новую', async () => {
    // ON CONFLICT DO NOTHING → RETURNING пуст, читаем существующую строку.
    h.queryOne.mockResolvedValueOnce(null);
    h.queryOne.mockResolvedValueOnce({
      operation_id: OPERATION_ID,
      status: 'sigur_created',
      sigur_employee_id: 49402,
      payload_hash: 'h',
    });

    const { operation, isNew } = await claimCreateOperation(OPERATION_ID, 'user-1', 'h');

    expect(isNew).toBe(false);
    expect(operation.sigur_employee_id).toBe(49402);
  });
});

describe('findSigurEmployeeIdByMarker', () => {
  it('находит карточку, созданную этой операцией', () => {
    const employees = [
      { id: 1, description: 'обычный' },
      { id: 49402, description: `Принят 01.09 ${buildOperationMarker(OPERATION_ID)}` },
    ];

    expect(findSigurEmployeeIdByMarker(employees, OPERATION_ID)).toBe(49402);
  });

  it('не путает разные операции', () => {
    const employees = [{ id: 49402, description: `${OPERATION_MARKER_PREFIX}00000000-0000-0000-0000-000000000000` }];

    expect(findSigurEmployeeIdByMarker(employees, OPERATION_ID)).toBeNull();
  });

  it('переносит регистр поля description из разных вариантов ответа Sigur', () => {
    const employees = [{ ID: 777, Description: buildOperationMarker(OPERATION_ID) }];

    expect(findSigurEmployeeIdByMarker(employees, OPERATION_ID)).toBe(777);
  });
});
