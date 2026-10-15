import { invalidateCaches } from '../middleware/cacheResponse.js';
import { notifySigurStructureChanged, type ISigurStructureNotification } from './skud-realtime.service.js';

/** HTTP-кэши GET /api/sigur/admin/* (регистрируются в sigur.routes.ts). */
export const SIGUR_ADMIN_CACHES = [
  'sigur:admin:departments',
  'sigur:admin:departments-tree',
  'sigur:admin:departments-counts',
  'sigur:admin:positions',
  'sigur:admin:employees',
  'sigur:admin:card-statuses',
  'sigur:admin:employee-profile',
  'sigur:admin:access-point-options',
] as const;

/**
 * Сбросить HTTP-кэши раздела SIGUR и разослать structure_updated: открытые экраны
 * перечитывают дерево и списки сразу, а не по истечении staleTime.
 */
export const refreshSigurAdminViews = (notification: ISigurStructureNotification): void => {
  invalidateCaches(...SIGUR_ADMIN_CACHES);
  notifySigurStructureChanged(notification);
};
