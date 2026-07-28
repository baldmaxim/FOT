/**
 * Типы обучения по охране труда. Каталог и статусы считает сервер
 * (fot-server/src/services/ot-training.service.ts) — клиент их только рисует.
 */

/** Вид обучения из каталога сервера (периодичность зашита там же). */
export interface IOtTrainingDef {
  kind: string;
  label: string;
  /** Периодичность из регламента — подсказка под подписью. */
  hint: string;
  /** null — бессрочно. */
  validMonths: number | null;
  audience: 'all' | 'employee';
  order: number;
  /** Вид с текстовым уточнением (профессия). */
  hasNote?: boolean;
  noteLabel?: string;
}

/** Состояние вида обучения. Дату окончания и статус считает сервер. */
export interface IOtTrainingState {
  kind: string;
  /** null — вид не пройден (status 'missing'). */
  passed_on: string | null;
  valid_until: string | null;
  status: 'missing' | 'valid' | 'expiring' | 'expired';
}

/** Состояние вида у своего сотрудника: плюс профессия для сквозных профессий. */
export interface IEmployeeOtTrainingState extends IOtTrainingState {
  note: string | null;
}

/** Патч дат обучения подрядчика: ключ отсутствует — вид не трогаем, null — снять дату. */
export type OtTrainingsPatch = Record<string, string | null>;
