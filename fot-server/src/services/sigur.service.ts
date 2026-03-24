/**
 * Barrel-файл: сохраняет обратную совместимость импорта sigurService.
 */
export type { ConnectionType } from './sigur-base.service.js';
export { SigurServiceBase } from './sigur-base.service.js';
export { SigurDataService } from './sigur-data.service.js';

import { SigurDataService } from './sigur-data.service.js';

export const sigurService = new SigurDataService();
