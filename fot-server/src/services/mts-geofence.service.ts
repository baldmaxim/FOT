/**
 * CRUD-сервис геозон МТС + назначения сотрудникам + чтение журнала нарушений.
 * Серверная валидация полигонов перед записью. Сами координаты зон НЕ
 * шифруются (это бизнес-объекты, не PII) — координаты нарушений шифруются.
 */
import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import {
  validatePolygon,
  type IGeoPoint,
  type PolygonValidationError,
} from './mts-geofence-geometry.js';

export interface IMtsGeofence {
  id: string;
  name: string;
  geometry: IGeoPoint[];
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  employeeIds: number[];
  skudObjectIds: string[];
}

export interface IMtsGeofenceAssignment {
  geofenceId: string;
  employeeId: number;
  assignedBy: string | null;
  assignedAt: string;
  isActive: boolean;
}

export interface IMtsGeofenceViolation {
  id: string;
  geofenceId: string;
  geofenceName: string | null;
  employeeId: number;
  employeeFullName: string | null;
  startedAt: string;
  endedAt: string | null;
  lastNotifiedAt: string | null;
  notifyCount: number;
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  source: string | null;
}

export class GeofenceValidationError extends Error {
  constructor(public readonly reason: PolygonValidationError | 'name_required' | 'name_too_long') {
    super(`Geofence validation failed: ${reason}`);
    this.name = 'GeofenceValidationError';
  }
}

const numFromEnc = (raw: string | null): number | null => {
  const v = encryptionService.decryptField(raw);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const validateName = (name: unknown): string => {
  if (typeof name !== 'string') throw new GeofenceValidationError('name_required');
  const trimmed = name.trim();
  if (!trimmed) throw new GeofenceValidationError('name_required');
  if (trimmed.length > 200) throw new GeofenceValidationError('name_too_long');
  return trimmed;
};

const validateGeometry = (raw: unknown): IGeoPoint[] => {
  const r = validatePolygon(raw);
  if (!r.ok) throw new GeofenceValidationError(r.error);
  return r.ring;
};

interface IGeofenceRow {
  id: string;
  name: string;
  geometry: IGeoPoint[];
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  employee_ids: number[] | null;
  skud_object_ids: string[] | null;
}

const mapRow = (row: IGeofenceRow): IMtsGeofence => ({
  id: row.id,
  name: row.name,
  geometry: Array.isArray(row.geometry) ? row.geometry : [],
  isActive: row.is_active,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  employeeIds: row.employee_ids ?? [],
  skudObjectIds: row.skud_object_ids ?? [],
});

export const mtsGeofenceService = {
  async listGeofences(opts: { onlyActive?: boolean } = {}): Promise<IMtsGeofence[]> {
    const onlyActive = opts.onlyActive ?? false;
    const rows = await query<IGeofenceRow>(
      `SELECT g.id, g.name, g.geometry, g.is_active, g.created_by, g.created_at, g.updated_at,
              COALESCE((
                SELECT ARRAY_AGG(a.employee_id)
                  FROM mts_geofence_assignments a
                 WHERE a.geofence_id = g.id AND a.is_active = true
              ), '{}') AS employee_ids,
              COALESCE((
                SELECT ARRAY_AGG(o.skud_object_id::text)
                  FROM mts_geofence_objects o
                 WHERE o.geofence_id = g.id
              ), '{}') AS skud_object_ids
         FROM mts_geofences g
        ${onlyActive ? 'WHERE g.is_active = true' : ''}
        ORDER BY g.created_at DESC`,
    );
    return rows.map(mapRow);
  },

  async getById(geofenceId: string): Promise<IMtsGeofence | null> {
    const row = await queryOne<IGeofenceRow>(
      `SELECT g.id, g.name, g.geometry, g.is_active, g.created_by, g.created_at, g.updated_at,
              COALESCE((
                SELECT ARRAY_AGG(a.employee_id)
                  FROM mts_geofence_assignments a
                 WHERE a.geofence_id = g.id AND a.is_active = true
              ), '{}') AS employee_ids,
              COALESCE((
                SELECT ARRAY_AGG(o.skud_object_id::text)
                  FROM mts_geofence_objects o
                 WHERE o.geofence_id = g.id
              ), '{}') AS skud_object_ids
         FROM mts_geofences g
        WHERE g.id = $1`,
      [geofenceId],
    );
    return row ? mapRow(row) : null;
  },

  async createGeofence(input: { name: unknown; geometry: unknown }, userId: string): Promise<IMtsGeofence> {
    const name = validateName(input.name);
    const ring = validateGeometry(input.geometry);
    const row = await queryOne<{ id: string }>(
      `INSERT INTO mts_geofences (name, geometry, created_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       RETURNING id`,
      [name, JSON.stringify(ring), userId],
    );
    if (!row) throw new Error('Не удалось создать геозону');
    const created = await this.getById(row.id);
    if (!created) throw new Error('Не удалось прочитать созданную геозону');
    return created;
  },

  async updateGeofence(
    geofenceId: string,
    input: { name?: unknown; geometry?: unknown; isActive?: unknown },
  ): Promise<IMtsGeofence | null> {
    const existing = await this.getById(geofenceId);
    if (!existing) return null;

    const sets: string[] = [];
    const args: unknown[] = [];
    let idx = 1;
    if (input.name !== undefined) {
      sets.push(`name = $${idx++}`);
      args.push(validateName(input.name));
    }
    if (input.geometry !== undefined) {
      sets.push(`geometry = $${idx++}::jsonb`);
      args.push(JSON.stringify(validateGeometry(input.geometry)));
    }
    if (input.isActive !== undefined) {
      sets.push(`is_active = $${idx++}`);
      args.push(Boolean(input.isActive));
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = NOW()');
    args.push(geofenceId);
    await execute(
      `UPDATE mts_geofences SET ${sets.join(', ')} WHERE id = $${idx}`,
      args,
    );
    return this.getById(geofenceId);
  },

  async deleteGeofence(geofenceId: string): Promise<boolean> {
    const affected = await execute('DELETE FROM mts_geofences WHERE id = $1', [geofenceId]);
    return affected > 0;
  },

  /** Replace-семантика: после вызова assignments = employeeIds. */
  async setAssignments(geofenceId: string, employeeIds: number[], userId: string): Promise<IMtsGeofence | null> {
    const existing = await this.getById(geofenceId);
    if (!existing) return null;

    const validIds = Array.from(new Set(employeeIds.filter(id => Number.isFinite(id) && id > 0)));

    await withTransaction(async client => {
      await client.query(
        'DELETE FROM mts_geofence_assignments WHERE geofence_id = $1',
        [geofenceId],
      );
      if (validIds.length > 0) {
        await client.query(
          `INSERT INTO mts_geofence_assignments (geofence_id, employee_id, assigned_by, assigned_at, is_active)
             SELECT $1, e.id, $2, NOW(), true
               FROM unnest($3::int[]) AS u(id)
               JOIN employees e ON e.id = u.id
            ON CONFLICT (geofence_id, employee_id) DO UPDATE SET
              assigned_by = EXCLUDED.assigned_by,
              assigned_at = NOW(),
              is_active = true`,
          [geofenceId, userId, validIds],
        );
      }
    });

    return this.getById(geofenceId);
  },

  /** Replace-семантика для привязки геозоны к объектам FOT (skud_objects). */
  async setObjectAssignments(
    geofenceId: string,
    skudObjectIds: string[],
    userId: string,
  ): Promise<IMtsGeofence | null> {
    const existing = await this.getById(geofenceId);
    if (!existing) return null;
    const validIds = Array.from(new Set(skudObjectIds.filter(id => typeof id === 'string' && id.length > 0)));

    await withTransaction(async client => {
      await client.query(
        'DELETE FROM mts_geofence_objects WHERE geofence_id = $1',
        [geofenceId],
      );
      if (validIds.length > 0) {
        await client.query(
          `INSERT INTO mts_geofence_objects (geofence_id, skud_object_id, assigned_by, assigned_at)
             SELECT $1, o.id, $2, NOW()
               FROM unnest($3::uuid[]) AS u(id)
               JOIN skud_objects o ON o.id = u.id
            ON CONFLICT (geofence_id, skud_object_id) DO NOTHING`,
          [geofenceId, userId, validIds],
        );
      }
    });

    return this.getById(geofenceId);
  },

  async listGeofencesForObject(skudObjectId: string): Promise<IMtsGeofence[]> {
    const rows = await query<IGeofenceRow>(
      `SELECT g.id, g.name, g.geometry, g.is_active, g.created_by, g.created_at, g.updated_at,
              COALESCE((
                SELECT ARRAY_AGG(a.employee_id)
                  FROM mts_geofence_assignments a
                 WHERE a.geofence_id = g.id AND a.is_active = true
              ), '{}') AS employee_ids,
              COALESCE((
                SELECT ARRAY_AGG(o2.skud_object_id::text)
                  FROM mts_geofence_objects o2
                 WHERE o2.geofence_id = g.id
              ), '{}') AS skud_object_ids
         FROM mts_geofences g
         JOIN mts_geofence_objects o ON o.geofence_id = g.id
        WHERE o.skud_object_id = $1
        ORDER BY g.created_at DESC`,
      [skudObjectId],
    );
    return rows.map(mapRow);
  },

  /** Активные назначения по сотруднику (используется поллером). */
  async listActiveAssignmentsForEmployees(employeeIds: number[]): Promise<Map<number, string[]>> {
    if (employeeIds.length === 0) return new Map();
    const rows = await query<{ employee_id: number; geofence_id: string }>(
      `SELECT a.employee_id, a.geofence_id
         FROM mts_geofence_assignments a
         JOIN mts_geofences g ON g.id = a.geofence_id
        WHERE a.is_active = true AND g.is_active = true
          AND a.employee_id = ANY($1::int[])`,
      [employeeIds],
    );
    const map = new Map<number, string[]>();
    for (const row of rows) {
      const ids = map.get(row.employee_id) || [];
      ids.push(row.geofence_id);
      map.set(row.employee_id, ids);
    }
    return map;
  },

  /**
   * Все активные пары (employee_id, geofence_id) с расшифрованной геометрией.
   * Используется поллером для пред-загрузки полигонов один раз за тик.
   */
  async loadActiveGeofencesWithAssignments(): Promise<{
    geofences: Map<string, { id: string; name: string; geometry: IGeoPoint[] }>;
    assignmentsByEmployee: Map<number, string[]>;
  }> {
    const geofenceRows = await query<{ id: string; name: string; geometry: IGeoPoint[] }>(
      `SELECT g.id, g.name, g.geometry
         FROM mts_geofences g
        WHERE g.is_active = true
          AND EXISTS (
            SELECT 1 FROM mts_geofence_assignments a
             WHERE a.geofence_id = g.id AND a.is_active = true
          )`,
    );
    const geofences = new Map<string, { id: string; name: string; geometry: IGeoPoint[] }>();
    for (const g of geofenceRows) {
      geofences.set(g.id, {
        id: g.id,
        name: g.name,
        geometry: Array.isArray(g.geometry) ? g.geometry : [],
      });
    }

    const assignRows = await query<{ employee_id: number; geofence_id: string }>(
      `SELECT a.employee_id, a.geofence_id
         FROM mts_geofence_assignments a
         JOIN mts_geofences g ON g.id = a.geofence_id
        WHERE a.is_active = true AND g.is_active = true`,
    );
    const assignmentsByEmployee = new Map<number, string[]>();
    for (const row of assignRows) {
      const ids = assignmentsByEmployee.get(row.employee_id) || [];
      ids.push(row.geofence_id);
      assignmentsByEmployee.set(row.employee_id, ids);
    }
    return { geofences, assignmentsByEmployee };
  },

  // ----- Нарушения -----

  async findOpenViolation(geofenceId: string, employeeId: number): Promise<{ id: string; notifyCount: number; lastNotifiedAt: string | null; startedAt: string } | null> {
    const row = await queryOne<{ id: string; notify_count: number; last_notified_at: string | null; started_at: string }>(
      `SELECT id, notify_count, last_notified_at, started_at
         FROM mts_geofence_violations
        WHERE geofence_id = $1 AND employee_id = $2 AND ended_at IS NULL
        ORDER BY started_at DESC
        LIMIT 1`,
      [geofenceId, employeeId],
    );
    if (!row) return null;
    return {
      id: row.id,
      notifyCount: row.notify_count,
      lastNotifiedAt: row.last_notified_at,
      startedAt: row.started_at,
    };
  },

  async openViolation(input: {
    geofenceId: string;
    employeeId: number;
    startedAt: Date;
    latitude: number | null;
    longitude: number | null;
    accuracyMeters: number | null;
    source: string | null;
  }): Promise<{ id: string }> {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO mts_geofence_violations
         (geofence_id, employee_id, started_at, latitude_enc, longitude_enc, accuracy_m_enc, source_enc)
       VALUES ($1, $2, $3::timestamptz, $4, $5, $6, $7)
       ON CONFLICT (geofence_id, employee_id) WHERE ended_at IS NULL DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [
        input.geofenceId,
        input.employeeId,
        input.startedAt.toISOString(),
        encryptionService.encryptField(input.latitude == null ? null : String(input.latitude)),
        encryptionService.encryptField(input.longitude == null ? null : String(input.longitude)),
        encryptionService.encryptField(input.accuracyMeters == null ? null : String(input.accuracyMeters)),
        encryptionService.encryptField(input.source),
      ],
    );
    if (!row) throw new Error('Не удалось открыть нарушение');
    return { id: row.id };
  },

  async markNotified(violationId: string): Promise<void> {
    await execute(
      `UPDATE mts_geofence_violations
          SET notify_count = notify_count + 1,
              last_notified_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [violationId],
    );
  },

  async closeViolation(violationId: string, endedAt: Date = new Date()): Promise<void> {
    await execute(
      `UPDATE mts_geofence_violations
          SET ended_at = $2::timestamptz, updated_at = NOW()
        WHERE id = $1 AND ended_at IS NULL`,
      [violationId, endedAt.toISOString()],
    );
  },

  async listViolations(opts: {
    employeeIds?: number[];
    geofenceIds?: string[];
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ data: IMtsGeofenceViolation[]; total: number }> {
    // Явно переданный пустой список геозон → фильтровать не по чему (нет привязок).
    if (opts.geofenceIds && opts.geofenceIds.length === 0) {
      return { data: [], total: 0 };
    }
    const limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const offset = Math.max(0, Number(opts.offset) || 0);

    const where: string[] = [];
    const args: unknown[] = [];
    let idx = 1;
    if (opts.employeeIds && opts.employeeIds.length > 0) {
      where.push(`v.employee_id = ANY($${idx++}::int[])`);
      args.push(opts.employeeIds);
    }
    if (opts.geofenceIds && opts.geofenceIds.length > 0) {
      where.push(`v.geofence_id = ANY($${idx++}::uuid[])`);
      args.push(opts.geofenceIds);
    }
    if (opts.from) {
      where.push(`v.started_at >= $${idx++}::timestamptz`);
      args.push(opts.from);
    }
    if (opts.to) {
      where.push(`v.started_at <= $${idx++}::timestamptz`);
      args.push(opts.to);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await query<{
      id: string;
      geofence_id: string;
      geofence_name: string | null;
      employee_id: number;
      employee_full_name: string | null;
      started_at: string;
      ended_at: string | null;
      last_notified_at: string | null;
      notify_count: number;
      latitude_enc: string | null;
      longitude_enc: string | null;
      accuracy_m_enc: string | null;
      source_enc: string | null;
      total_count: number;
    }>(
      `SELECT v.id, v.geofence_id, g.name AS geofence_name,
              v.employee_id, e.full_name AS employee_full_name,
              v.started_at, v.ended_at, v.last_notified_at, v.notify_count,
              v.latitude_enc, v.longitude_enc, v.accuracy_m_enc, v.source_enc,
              count(*) OVER ()::int AS total_count
         FROM mts_geofence_violations v
         LEFT JOIN mts_geofences g ON g.id = v.geofence_id
         LEFT JOIN employees e ON e.id = v.employee_id
        ${whereSql}
        ORDER BY v.started_at DESC
        LIMIT $${idx++} OFFSET $${idx}`,
      [...args, limit, offset],
    );

    const data = rows.map(r => ({
      id: r.id,
      geofenceId: r.geofence_id,
      geofenceName: r.geofence_name,
      employeeId: r.employee_id,
      employeeFullName: r.employee_full_name,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      lastNotifiedAt: r.last_notified_at,
      notifyCount: r.notify_count,
      latitude: numFromEnc(r.latitude_enc),
      longitude: numFromEnc(r.longitude_enc),
      accuracyMeters: numFromEnc(r.accuracy_m_enc),
      source: encryptionService.decryptField(r.source_enc),
    }));
    const total = rows.length > 0 ? rows[0].total_count : 0;
    return { data, total };
  },
};
