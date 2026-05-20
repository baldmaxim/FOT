import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  pgQuery,
  loadActiveGeofencesWithAssignments,
  findOpenViolation,
  openViolation,
  closeViolation,
  markNotified,
  notify,
  getActiveShiftWindow,
  decryptField,
} = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  loadActiveGeofencesWithAssignments: vi.fn(),
  findOpenViolation: vi.fn(),
  openViolation: vi.fn(),
  closeViolation: vi.fn(),
  markNotified: vi.fn(),
  notify: vi.fn(),
  getActiveShiftWindow: vi.fn(),
  decryptField: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: pgQuery }));
vi.mock('./mts-geofence.service.js', () => ({
  mtsGeofenceService: {
    loadActiveGeofencesWithAssignments,
    findOpenViolation,
    openViolation,
    closeViolation,
    markNotified,
  },
}));
vi.mock('./notification.service.js', () => ({
  notificationService: { createMany: notify },
}));
vi.mock('./mts-geofence-geometry.js', async () => {
  const actual = await vi.importActual<typeof import('./mts-geofence-geometry.js')>('./mts-geofence-geometry.js');
  return { ...actual, getActiveShiftWindow };
});
vi.mock('./encryption.service.js', () => ({
  encryptionService: { decryptField },
}));

import { runGeofenceMonitorTick, __resetGeofenceMonitorForTests } from './mts-geofence-monitor.service.js';

const SQUARE = [
  { lat: 55.7500, lng: 37.6100 },
  { lat: 55.7500, lng: 37.6300 },
  { lat: 55.7600, lng: 37.6300 },
  { lat: 55.7600, lng: 37.6100 },
];

// Точка вне квадрата (далеко): lat 55.7000 — ~5км южнее.
const OUTSIDE_POINT = { lat: 55.7000, lng: 37.6200 };
// Точка внутри: 55.7550, 37.6200
const INSIDE_POINT = { lat: 55.7550, lng: 37.6200 };

const setupMocks = (opts: {
  snapshotPoint: { lat: number; lng: number };
  accuracy: number;
  source?: string;
}): void => {
  loadActiveGeofencesWithAssignments.mockResolvedValue({
    geofences: new Map([
      ['g-1', { id: 'g-1', name: 'Office', geometry: SQUARE }],
    ]),
    assignmentsByEmployee: new Map([[42, ['g-1']]]),
  });
  getActiveShiftWindow.mockResolvedValue({ startsAt: new Date(), endsAt: new Date(Date.now() + 1000), origin: 'today' });

  pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('mts_subscriber_map')) {
      return [{ subscriber_id: 100, employee_id: 42 }];
    }
    if (sql.includes('DISTINCT ON (subscriber_id)')) {
      return [{
        subscriber_id: 100,
        recorded_at: new Date().toISOString(),
        lat_enc: 'enc-lat',
        lon_enc: 'enc-lng',
        accuracy_m_enc: 'enc-acc',
        source_enc: 'enc-src',
      }];
    }
    if (sql.includes('position_type')) {
      return [{ id: 'admin-1' }, { id: 'admin-2' }];
    }
    if (sql.includes('FROM employees WHERE id')) {
      return [{ full_name: 'Иванов Иван' }];
    }
    return [];
  });

  decryptField.mockImplementation((v: string | null | undefined): string | null => {
    if (v === 'enc-lat') return String(opts.snapshotPoint.lat);
    if (v === 'enc-lng') return String(opts.snapshotPoint.lng);
    if (v === 'enc-acc') return String(opts.accuracy);
    if (v === 'enc-src') return opts.source ?? 'lbs';
    return null;
  });
};

describe('mts-geofence-monitor runGeofenceMonitorTick', () => {
  beforeEach(() => {
    __resetGeofenceMonitorForTests();
    pgQuery.mockReset();
    loadActiveGeofencesWithAssignments.mockReset();
    findOpenViolation.mockReset();
    openViolation.mockReset();
    closeViolation.mockReset();
    markNotified.mockReset();
    notify.mockReset();
    getActiveShiftWindow.mockReset();
    decryptField.mockReset();
  });

  it('открывает violation после ВТОРОГО подряд out-of-zone тика (dwell=2)', async () => {
    setupMocks({ snapshotPoint: OUTSIDE_POINT, accuracy: 10 });
    findOpenViolation.mockResolvedValue(null);
    openViolation.mockResolvedValue({ id: 'v-1' });

    // Тик 1
    await runGeofenceMonitorTick();
    expect(openViolation).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();

    // Тик 2 — должен открыть и уведомить
    await runGeofenceMonitorTick();
    expect(openViolation).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    const notifications = notify.mock.calls[0][0] as { userId: string; type: string }[];
    expect(notifications).toHaveLength(2); // оба super_admin
    expect(notifications[0].type).toBe('MTS_GEOFENCE_VIOLATION');
    expect(markNotified).toHaveBeenCalledWith('v-1');
  });

  it('закрывает violation после первого in-zone тика', async () => {
    setupMocks({ snapshotPoint: INSIDE_POINT, accuracy: 10 });
    findOpenViolation.mockResolvedValue({ id: 'v-1', notifyCount: 1, lastNotifiedAt: null, startedAt: new Date().toISOString() });

    await runGeofenceMonitorTick();
    expect(closeViolation).toHaveBeenCalledWith('v-1', expect.any(Date));
    expect(openViolation).not.toHaveBeenCalled();
  });

  it('ambiguous (точка близко к краю с большой accuracy) не меняет состояние', async () => {
    // 0.001 deg lat ≈ 111м от ребра → с accuracy=500 это ambiguous
    setupMocks({ snapshotPoint: { lat: 55.7610, lng: 37.6200 }, accuracy: 500 });
    findOpenViolation.mockResolvedValue(null);

    await runGeofenceMonitorTick();
    await runGeofenceMonitorTick();
    expect(openViolation).not.toHaveBeenCalled();
    expect(closeViolation).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('пропускает сотрудника вне смены', async () => {
    setupMocks({ snapshotPoint: OUTSIDE_POINT, accuracy: 10 });
    getActiveShiftWindow.mockResolvedValue(null); // вне смены
    findOpenViolation.mockResolvedValue(null);

    await runGeofenceMonitorTick();
    await runGeofenceMonitorTick();
    expect(openViolation).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('не уведомляет повторно если открытое нарушение получило уведомление < REPEAT_MIN назад', async () => {
    setupMocks({ snapshotPoint: OUTSIDE_POINT, accuracy: 10 });
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1 минута назад
    findOpenViolation.mockResolvedValue({ id: 'v-1', notifyCount: 1, lastNotifiedAt: recent, startedAt: new Date().toISOString() });

    await runGeofenceMonitorTick();
    await runGeofenceMonitorTick();
    expect(notify).not.toHaveBeenCalled();
    expect(markNotified).not.toHaveBeenCalled();
  });

  it('уведомляет повторно если открытое нарушение старее REPEAT_MIN', async () => {
    setupMocks({ snapshotPoint: OUTSIDE_POINT, accuracy: 10 });
    const long = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 час
    findOpenViolation.mockResolvedValue({ id: 'v-1', notifyCount: 1, lastNotifiedAt: long, startedAt: long });

    // dwell=1
    await runGeofenceMonitorTick();
    // dwell=2 → проверка через findOpenViolation → видит открытое → REPEAT-таймер истёк → notify
    await runGeofenceMonitorTick();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(markNotified).toHaveBeenCalledWith('v-1');
  });
});
