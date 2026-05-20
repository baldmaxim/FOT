import { execute } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { MtsServiceBase } from './mts-base.service.js';

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
