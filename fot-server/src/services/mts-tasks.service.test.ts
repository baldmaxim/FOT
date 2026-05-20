import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pgQueryOne, pgQuery, pgExecute } = vi.hoisted(() => ({
  pgQueryOne: vi.fn(),
  pgQuery: vi.fn(),
  pgExecute: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  execute: pgExecute,
  query: pgQuery,
  queryOne: pgQueryOne,
}));

import { mtsTasksService } from './mts-tasks.service.js';
import { encryptionService } from './encryption.service.js';

describe('mts-tasks.service: контент задачи в БД только зашифрован', () => {
  beforeEach(() => {
    pgQueryOne.mockReset();
    pgQuery.mockReset();
    pgExecute.mockReset();
  });

  it('saveCreatedTask шифрует title/description/address/status/payload перед INSERT', async () => {
    pgQueryOne.mockResolvedValue({
      id: 1,
      mts_task_id: 777,
      subscriber_id: 42,
      start_date: '2026-05-20T10:00:00+03:00',
      deadline: null,
      created_by: 'user-uuid',
      title_enc: 'irrelevant',
      description_enc: null,
      address_enc: null,
      status_enc: null,
      created_at: '2026-05-20T10:00:00Z',
      synced_at: '2026-05-20T10:00:00Z',
    });

    await mtsTasksService.saveCreatedTask({
      mtsTaskId: 777,
      subscriberId: 42,
      startDate: '2026-05-20T10:00:00+03:00',
      deadline: null,
      title: 'Доставить документы клиенту',
      description: 'Адрес: Москва, Красная пл.',
      address: 'Москва, Красная площадь',
      status: 'CREATED',
      payload: { taskID: 777, status: 'CREATED' },
      createdBy: 'user-uuid',
    });

    expect(pgQueryOne).toHaveBeenCalledTimes(1);
    const params = pgQueryOne.mock.calls[0][1] as unknown[];
    // [mtsTaskId, subscriberId, startDate, deadline, createdBy,
    //  title_enc, description_enc, address_enc, status_enc, payload_enc]
    const [, , , , , titleEnc, descEnc, addrEnc, statusEnc, payloadEnc] = params;

    // В открытом виде ничего нет
    expect(String(titleEnc)).not.toContain('Доставить документы');
    expect(String(descEnc)).not.toContain('Красная');
    expect(String(addrEnc)).not.toContain('Красная');
    expect(String(statusEnc)).not.toContain('CREATED');
    expect(String(payloadEnc)).not.toContain('CREATED');
    expect(String(payloadEnc)).not.toContain('777');

    // Ciphertext формата iv:authTag:encrypted и обратимо
    expect(String(titleEnc).split(':')).toHaveLength(3);
    expect(encryptionService.decryptField(titleEnc as string)).toBe('Доставить документы клиенту');
    expect(encryptionService.decryptField(addrEnc as string)).toBe('Москва, Красная площадь');
    expect(encryptionService.decryptField(statusEnc as string)).toBe('CREATED');
    expect(JSON.parse(encryptionService.decryptField(payloadEnc as string)!)).toMatchObject({
      taskID: 777,
      status: 'CREATED',
    });
  });

  it('upsertSyncedTask шифрует обновляемый status и payload', async () => {
    pgExecute.mockResolvedValue(1);
    await mtsTasksService.upsertSyncedTask(777, { taskID: 777, status: 'IN_PROGRESS', extra: 'x' });

    expect(pgExecute).toHaveBeenCalledTimes(1);
    const params = pgExecute.mock.calls[0][1] as unknown[];
    const [statusEnc, payloadEnc] = params;
    expect(String(statusEnc)).not.toContain('IN_PROGRESS');
    expect(String(payloadEnc)).not.toContain('IN_PROGRESS');
    expect(encryptionService.decryptField(statusEnc as string)).toBe('IN_PROGRESS');
    expect(JSON.parse(encryptionService.decryptField(payloadEnc as string)!)).toMatchObject({
      taskID: 777,
      status: 'IN_PROGRESS',
    });
  });
});
