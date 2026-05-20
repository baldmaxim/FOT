import { execute, query } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { MtsServiceBase } from './mts-base.service.js';

export interface IMtsTaskCreatePayload {
  title: string;
  startDate: string;
  subscriberID?: number | null;
  deadline?: string | null;
  description?: string | null;
  address?: string | null;
}

export interface IMtsTaskApiResponse {
  taskID: number;
  status?: string | null;
  creationDate?: string | null;
  [k: string]: unknown;
}

export interface IMtsLocationHistoryPoint {
  recordedAt: string;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  address: string | null;
  state: string | null;
  source: string | null;
}

// Доступ к данным МТС «Мобильные сотрудники» + персист зашифрованных снимков
// позиций. Контракт: docs/mts-mobile-staff-api.md.

export interface IMtsSubscriber {
  subscriberID: number;
  name: string | null;
  phone: string | null;
  isOnline: boolean | null;
  canTrack: boolean | null;
  isLocateEnabled: boolean | null;
  longitude: number | null;
  latitude: number | null;
}

export interface IMtsLocation {
  subscriberID: number;
  locationDate: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  address: string | null;
  state: string | null;
  source: string | null;
}

export interface IMtsTrackSegment {
  trackID: number;
  subscriberID: number;
  startDate: string | null;
  finishDate: string | null;
  startAddress: string | null;
  finishAddress: string | null;
  startLat: number | null;
  startLon: number | null;
  finishLat: number | null;
  finishLon: number | null;
  distance: number | null;
  duration: number | null;
}

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === '' ? null : Number(v);
const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

const SUBSCRIBERS_TTL_MS = 60_000;

class MtsDataService extends MtsServiceBase {
  private subscribersCache: { at: number; data: IMtsSubscriber[] } | null = null;

  /** Лёгкий вызов для проверки токена/доступа. */
  async testConnection(): Promise<{ ok: boolean; count: number }> {
    const subs = await this.fetchSubscribers();
    return { ok: true, count: subs.length };
  }

  private async fetchSubscribers(): Promise<IMtsSubscriber[]> {
    const payload = await this.request<unknown>('get', '/subscriberManagement/subscribers', {
      params: { isActive: true },
    });
    return this.extractItems<Record<string, unknown>>(payload).map(r => ({
      subscriberID: Number(r.subscriberID),
      name: str(r.name),
      phone: str(r.phone),
      isOnline: r.isOnline === undefined ? null : Boolean(r.isOnline),
      canTrack: r.canTrack === undefined ? null : Boolean(r.canTrack),
      isLocateEnabled: r.isLocateEnabled === undefined ? null : Boolean(r.isLocateEnabled),
      longitude: num(r.longitude),
      latitude: num(r.latitude),
    }));
  }

  async getSubscribers(force = false): Promise<IMtsSubscriber[]> {
    if (!force && this.subscribersCache && Date.now() - this.subscribersCache.at < SUBSCRIBERS_TTL_MS) {
      return this.subscribersCache.data;
    }
    const data = await this.fetchSubscribers();
    this.subscribersCache = { at: Date.now(), data };
    return data;
  }

  async getSubscriberGroups(): Promise<Array<{ subscriberGroupID: number; name: string | null }>> {
    const payload = await this.request<unknown>('get', '/subscriberManagement/subscriberGroups');
    return this.extractItems<Record<string, unknown>>(payload).map(r => ({
      subscriberGroupID: Number(r.subscriberGroupID),
      name: str(r.name),
    }));
  }

  async getLastLocations(): Promise<IMtsLocation[]> {
    const payload = await this.request<unknown>('get', '/subscriberManagement/subscribers/lastLocations');
    return this.extractItems<Record<string, unknown>>(payload).map(r => ({
      subscriberID: Number(r.subscriberID),
      locationDate: str(r.locationDate),
      latitude: num(r.latitude),
      longitude: num(r.longitude),
      accuracy: num(r.accuracy ?? r.radius),
      address: str(r.address),
      state: str(r.state),
      source: str(r.source),
    }));
  }

  async getTrack(subscriberId: number, dateFrom: string, dateTo: string): Promise<IMtsTrackSegment[]> {
    const payload = await this.request<unknown>('get', '/mobilePositioningManagement/tracks', {
      params: { subscriberIDs: subscriberId, dateFrom, dateTo, count: 200 },
    });
    return this.extractItems<Record<string, unknown>>(payload).map(r => ({
      trackID: Number(r.trackID),
      subscriberID: Number(r.subscriberID),
      startDate: str(r.startDate),
      finishDate: str(r.finishDate),
      startAddress: str(r.startAddress),
      finishAddress: str(r.finishAddress),
      startLat: num(r.startLat),
      startLon: num(r.startLon),
      finishLat: num(r.finishLat),
      finishLon: num(r.finishLon),
      distance: num(r.distance),
      duration: num(r.duration),
    }));
  }

  /**
   * Создаёт задачу в МТС (`POST /v6/api/taskManagement/tasks`).
   * Обязательные поля по контракту M-Poisk: title, startDate. Возвращает taskID
   * и сырой ответ — caller-сервис кладёт зашифрованную копию в mts_tasks.
   */
  async createTaskMts(payload: IMtsTaskCreatePayload): Promise<IMtsTaskApiResponse> {
    const body: Record<string, unknown> = {
      title: payload.title,
      startDate: payload.startDate,
    };
    if (payload.subscriberID != null) body.subscriberID = payload.subscriberID;
    if (payload.deadline) body.deadline = payload.deadline;
    if (payload.description) body.description = payload.description;
    if (payload.address) body.address = payload.address;

    const raw = await this.request<unknown>('post', '/taskManagement/tasks', { data: body });
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const taskID = Number(obj.taskID);
    if (!Number.isFinite(taskID)) {
      throw new Error('МТС не вернул taskID в ответе на создание задачи');
    }
    return { ...(obj as IMtsTaskApiResponse), taskID };
  }

  async getTaskMts(taskId: number): Promise<IMtsTaskApiResponse> {
    const raw = await this.request<unknown>('get', `/taskManagement/tasks/${taskId}`);
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return { ...(obj as IMtsTaskApiResponse), taskID: Number(obj.taskID ?? taskId) };
  }

  /**
   * Принудительный запрос актуального местоположения у МТС (платный, по тарифу
   * M-Poisk ~3–5 ₽). Дёргается ТОЛЬКО вручную с UI после явного подтверждения
   * пользователя, не в фоне. Контракт subscriberRequests — body { subscriberID },
   * MTS обновит lastLocation; результат подтянется при следующем GET lastLocations.
   */
  async requestLocation(subscriberId: number): Promise<{ ok: boolean; raw: unknown }> {
    const raw = await this.request<unknown>('post', '/subscriberManagement/subscriberRequests', {
      data: { subscriberID: subscriberId },
    });
    return { ok: true, raw };
  }

  /**
   * Читает зашифрованную историю из mts_location_snapshots и расшифровывает в памяти.
   * Используется endpoint'ом /history с проверкой data-scope/IDOR.
   */
  async getHistorySnapshots(
    subscriberId: number,
    dateFrom: string,
    dateTo: string,
    limit = 5000,
  ): Promise<IMtsLocationHistoryPoint[]> {
    const rows = await query<{
      recorded_at: string;
      lat_enc: string | null;
      lon_enc: string | null;
      accuracy_m_enc: string | null;
      address_enc: string | null;
      state_enc: string | null;
      source_enc: string | null;
    }>(
      `SELECT recorded_at, lat_enc, lon_enc, accuracy_m_enc, address_enc, state_enc, source_enc
         FROM mts_location_snapshots
        WHERE subscriber_id = $1
          AND recorded_at >= $2::timestamptz
          AND recorded_at <= $3::timestamptz
        ORDER BY recorded_at DESC
        LIMIT $4`,
      [subscriberId, dateFrom, dateTo, limit],
    );

    const numOrNull = (raw: string | null): number | null => {
      const v = encryptionService.decryptField(raw);
      if (v === null || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    return rows.map(r => ({
      recordedAt: r.recorded_at,
      latitude: numOrNull(r.lat_enc),
      longitude: numOrNull(r.lon_enc),
      accuracy: numOrNull(r.accuracy_m_enc),
      address: encryptionService.decryptField(r.address_enc),
      state: encryptionService.decryptField(r.state_enc),
      source: encryptionService.decryptField(r.source_enc),
    }));
  }

  /**
   * Сохраняет снимки позиций в БД. Контент МТС шифруется (AES-256-GCM) —
   * в открытом виде в БД ничего из этого сервиса не лежит. Дедуп по
   * (subscriber_id, recorded_at).
   */
  async persistLocationSnapshots(locations: IMtsLocation[]): Promise<number> {
    let saved = 0;
    for (const loc of locations) {
      if (!loc.subscriberID || !loc.locationDate) continue;
      const enc = (v: unknown): string | null =>
        v === null || v === undefined ? null : encryptionService.encrypt(String(v));
      const affected = await execute(
        `INSERT INTO mts_location_snapshots
           (subscriber_id, lat_enc, lon_enc, accuracy_m_enc, address_enc, state_enc, source_enc, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (subscriber_id, recorded_at) DO NOTHING`,
        [
          loc.subscriberID,
          enc(loc.latitude),
          enc(loc.longitude),
          enc(loc.accuracy),
          enc(loc.address),
          enc(loc.state),
          enc(loc.source),
          loc.locationDate,
        ],
      );
      saved += affected;
    }
    return saved;
  }
}

export const mtsDataService = new MtsDataService();
