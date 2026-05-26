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
  /** ID групп абонента (приходит как массив или null). */
  subscriberGroupIDs?: number[] | null;
  /** Значения кастомных полей (withCustomTemplateItems=true). */
  customTemplateItems?: unknown[] | null;
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

export interface IMtsGpsPoint {
  locationID: number;
  subscriberID: number;
  locationDate: string | null;
  latitude: number | null;
  longitude: number | null;
  angle: number | null;
  velocity: number | null;
  isValid: boolean | null;
}

export interface IMtsSubscriberGroup {
  subscriberGroupID: number;
  name: string | null;
  /** Прочие поля группы — отдаём фронту как есть. */
  [k: string]: unknown;
}

export interface IMtsCustomField {
  customFieldID?: number;
  name?: string | null;
  type?: string | null;
  isRequired?: boolean | null;
  [k: string]: unknown;
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
    // Без фильтра — МТС-аккаунт может держать абонентов без флага isActive=true
    // (например, добавленные через CSV-импорт или из приложения «Координатор»).
    // Фильтрацию по активности оставляем на UI. withCustomTemplateItems=true
    // отдаёт значения кастомных полей и связи с группами (бесплатно, GET).
    const payload = await this.request<unknown>(
      'get',
      '/subscriberManagement/subscribers',
      { params: { withCustomTemplateItems: true } },
    );
    // Один диагностический лог: какова форма ответа МТС. Без PII — только тип/ключи/длина.
    const shape = Array.isArray(payload)
      ? `array(len=${payload.length})`
      : payload && typeof payload === 'object'
        ? `object(keys=[${Object.keys(payload).join(',')}])`
        : `primitive(${typeof payload})`;
    console.log(`[mts] subscribers raw payload shape: ${shape}`);
    return this.extractItems<Record<string, unknown>>(payload).map(r => ({
      subscriberID: Number(r.subscriberID),
      name: str(r.name),
      phone: str(r.phone),
      isOnline: r.isOnline === undefined ? null : Boolean(r.isOnline),
      canTrack: r.canTrack === undefined ? null : Boolean(r.canTrack),
      isLocateEnabled: r.isLocateEnabled === undefined ? null : Boolean(r.isLocateEnabled),
      longitude: num(r.longitude),
      latitude: num(r.latitude),
      subscriberGroupIDs: Array.isArray(r.subscriberGroupIDs)
        ? (r.subscriberGroupIDs as unknown[]).map(v => Number(v)).filter(n => Number.isFinite(n))
        : null,
      customTemplateItems: Array.isArray(r.customTemplateItems)
        ? (r.customTemplateItems as unknown[])
        : null,
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

  /**
   * Диагностика: возвращает первый сырой объект из ответа MTS /subscribers
   * с зачищенными PII-полями (имя/телефон/externalID/координаты). Используется
   * только админом, чтобы понять реальные имена полей у апстрима. PII НЕ
   * раскрывается — отдаём только длину строки и тип значения.
   */
  async getRawSubscriberDebug(): Promise<{
    topLevelKeys: string[];
    redacted: Record<string, unknown>;
    valueTypes: Record<string, string>;
    fetchedAt: string;
  } | null> {
    const payload = await this.request<unknown>(
      'get',
      '/subscriberManagement/subscribers',
      { params: { withCustomTemplateItems: true, count: 1 } },
    );
    const items = this.extractItems<Record<string, unknown>>(payload);
    if (items.length === 0) return null;
    const first = items[0];
    const piiKeys = new Set([
      'name', 'phone', 'phoneNumber', 'Phone', 'PhoneNumber',
      'externalID', 'ExternalID', 'external_id',
      'latitude', 'longitude', 'Latitude', 'Longitude',
      'address', 'Address',
    ]);
    const redacted: Record<string, unknown> = {};
    const valueTypes: Record<string, string> = {};
    for (const [k, v] of Object.entries(first)) {
      valueTypes[k] = v === null ? 'null' : Array.isArray(v) ? `array(len=${v.length})` : typeof v;
      if (piiKeys.has(k)) {
        if (v === null || v === undefined) {
          redacted[k] = v;
        } else if (typeof v === 'string') {
          redacted[k] = `<redacted, str len=${v.length}>`;
        } else if (typeof v === 'number') {
          redacted[k] = `<redacted, ${typeof v}>`;
        } else {
          redacted[k] = `<redacted, ${typeof v}>`;
        }
      } else {
        redacted[k] = v;
      }
    }
    return {
      topLevelKeys: Object.keys(first),
      redacted,
      valueTypes,
      fetchedAt: new Date().toISOString(),
    };
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
   * Полные данные одной группы абонентов (бесплатно, GET).
   * Возвращаем raw payload — поля разнятся между тарифами.
   */
  async getSubscriberGroupDetails(groupId: number): Promise<IMtsSubscriberGroup> {
    const raw = await this.request<unknown>(
      'get',
      `/subscriberManagement/subscriberGroups/${groupId}`,
    );
    const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      subscriberGroupID: Number(obj.subscriberGroupID ?? groupId),
      name: str(obj.name),
      ...obj,
    } as IMtsSubscriberGroup;
  }

  /**
   * Определения шаблонов кастомных полей (бесплатно, GET).
   * Сами значения по абоненту приходят через withCustomTemplateItems в fetchSubscribers.
   */
  async getCustomFields(): Promise<IMtsCustomField[]> {
    const payload = await this.request<unknown>('get', '/customFieldsManagement/customFields');
    return this.extractItems<Record<string, unknown>>(payload).map(r => ({
      customFieldID: r.customFieldID == null ? undefined : Number(r.customFieldID),
      name: str(r.name),
      type: str(r.type),
      isRequired: r.isRequired === undefined ? null : Boolean(r.isRequired),
      ...r,
    } as IMtsCustomField));
  }

  /**
   * Пагинированный читатель списочных GET-эндпоинтов МТС. Используется для LBS/GPS.
   * Останавливаемся когда страница вернула < pageSize или закончились страницы.
   */
  private async paginate<T>(
    path: string,
    baseParams: Record<string, unknown>,
    lastIdParam: string,
    idField: string,
    pageSize: number,
    maxPages: number,
    mapper: (r: Record<string, unknown>) => T,
  ): Promise<T[]> {
    const all: T[] = [];
    let lastId: number | null = null;
    for (let i = 0; i < maxPages; i++) {
      const params: Record<string, unknown> = { ...baseParams, count: pageSize };
      if (lastId !== null) params[lastIdParam] = lastId;
      const payload = await this.request<unknown>('get', path, { params });
      const rows = this.extractItems<Record<string, unknown>>(payload);
      for (const r of rows) all.push(mapper(r));
      if (rows.length < pageSize) break;
      const tail = rows[rows.length - 1];
      const nextId = Number(tail?.[idField]);
      if (!Number.isFinite(nextId)) break;
      lastId = nextId;
    }
    return all;
  }

  /**
   * Исторические LBS-локации за интервал (бесплатно, GET). Данные — позиции,
   * уже определённые в МТС (поллер/прошлые платные запросы). Сами POST-запросы
   * на определение тут НЕ делаем — только читаем накопленное.
   */
  async getLocationsRange(
    dateFrom: string,
    dateTo: string,
    maxPages = 10,
  ): Promise<IMtsLocation[]> {
    return this.paginate<IMtsLocation>(
      '/mobilePositioningManagement/locations',
      { dateFrom, dateTo },
      'lastLocationID',
      'locationID',
      200,
      maxPages,
      r => ({
        subscriberID: Number(r.subscriberID),
        locationDate: str(r.locationDate),
        latitude: num(r.latitude),
        longitude: num(r.longitude),
        accuracy: num(r.accuracy ?? r.radius),
        address: str(r.address),
        state: str(r.state),
        source: str(r.source),
      }),
    );
  }

  /**
   * Треки за интервал по всем абонентам (бесплатно, GET).
   */
  async getTracksRange(
    dateFrom: string,
    dateTo: string,
    maxPages = 10,
  ): Promise<IMtsTrackSegment[]> {
    return this.paginate<IMtsTrackSegment>(
      '/mobilePositioningManagement/tracks',
      { dateFrom, dateTo },
      'lastTrackID',
      'trackID',
      200,
      maxPages,
      r => ({
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
      }),
    );
  }

  /**
   * GPS-точки за интервал (приходят с приложения МТС-Координатор на телефоне
   * сотрудника, бесплатно, GET). Лимит выборки до 1000 (контракт, код 67).
   */
  async getGlobalLocations(
    dateFrom: string,
    dateTo: string,
    maxPages = 5,
  ): Promise<IMtsGpsPoint[]> {
    return this.paginate<IMtsGpsPoint>(
      '/globalPositioningManagement/locations',
      { dateFrom, dateTo },
      'lastLocationID',
      'locationID',
      1000,
      maxPages,
      r => ({
        locationID: Number(r.locationID),
        subscriberID: Number(r.subscriberID),
        locationDate: str(r.locationDate),
        latitude: num(r.latitude),
        longitude: num(r.longitude),
        angle: num(r.angle),
        velocity: num(r.velocity),
        isValid: r.isValid === undefined ? null : Boolean(r.isValid),
      }),
    );
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
