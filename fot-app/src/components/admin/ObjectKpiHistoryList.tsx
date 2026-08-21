import type { FC } from 'react';

import type { IObjectKpiHistoryEntry } from '../../api/objectKpi';
import { formatDate, formatMoney, formatMonthLabel } from '../../utils/formatMoney';
import { formatFioShort } from '../../utils/formatFio';
import styles from './ObjectKpiHistoryList.module.css';

/**
 * История изменений по объекту: кто, что и когда сделал, с переходом «было → стало».
 *
 * Заголовок строки выводится из смены СТАТУСА, а не из action: подписание и аннулирование
 * пишутся в журнал как action='update', и по нему одному получилось бы бессодержательное
 * «Акт изменён» вместо «Акт КС-2 подписан».
 */

const ENTITY_LABELS: Record<string, string> = {
  contract: 'Договор',
  addendum: 'Допсоглашение',
  ks2: 'Акт КС-2',
  ks6: 'Запись КС-6',
  assignment: 'Закрепление',
  global_role: 'Роль руководителя эк. отдела',
  plan: 'План месяца',
};

const ACTION_LABELS: Record<string, string> = {
  create: 'создан',
  update: 'изменён',
  delete: 'удалён',
};

const STATUS_ACTIONS: Record<string, string> = {
  signed: 'подписан',
  cancelled: 'аннулирован',
  draft: 'возвращён в черновик',
};

const FIELD_LABELS: Record<string, string> = {
  contract_number: 'Номер договора',
  contract_date: 'Дата договора',
  customer_name: 'Заказчик',
  base_amount: 'Стоимость договора',
  planned_zos_date: 'Плановая ЗОС',
  actual_zos_date: 'Фактическая ЗОС',
  plan_start_month: 'Первый расчётный месяц',
  opening_remainder: 'Остаток на первый расчётный месяц',
  planned_headcount: 'Плановая численность',
  is_active: 'Активность',
  notes: 'Примечание',
  addendum_number: 'Номер ДС',
  addendum_date: 'Дата ДС',
  effective_date: 'Действует с',
  amount_delta: 'Сумма ДС',
  act_number: 'Номер акта',
  doc_number: 'Номер КС-6',
  customer_signed_date: 'Подписан заказчиком',
  entry_kind: 'Вид записи',
  amount: 'Сумма',
  status: 'Статус',
  valid_from: 'Период с',
  valid_to: 'Период по',
  role_kind: 'Роль',
  employee_id: 'Сотрудник',
  plan_amount: 'План месяца',
  override_plan_amount: 'Ручной план',
  calculated_plan_amount: 'Расчётный план',
  remainder: 'Остаток',
  months_remaining: 'Расчётных месяцев',
  control_date: 'Контрольная дата',
  revision: 'Ревизия',
  period_month: 'Расчётный месяц',
};

/**
 * Служебные поля снимка. В журнал они попадают вместе со всей строкой, но человеку
 * ничего не говорят: «version: 2 → 3» и «updated_at» занимали половину карточки и
 * заслоняли собственно правку.
 */
const TECHNICAL_FIELDS = new Set([
  'version', 'created_at', 'updated_at', 'created_by', 'updated_by', 'source',
]);

const MONEY_FIELDS = new Set([
  'base_amount', 'amount', 'amount_delta', 'plan_amount',
  'override_plan_amount', 'calculated_plan_amount', 'remainder', 'contract_total',
  'opening_remainder',
]);

const DATE_FIELDS = new Set([
  'contract_date', 'planned_zos_date', 'actual_zos_date', 'addendum_date',
  'effective_date', 'customer_signed_date', 'valid_from', 'valid_to', 'control_date',
]);

const ENTRY_STATUS_LABELS: Record<string, string> = {
  draft: 'черновик',
  signed: 'подписан',
  cancelled: 'аннулирован',
  open: 'открыт',
  fixed: 'зафиксирован',
  corrected: 'пересмотрен',
  data_incomplete: 'неполные данные',
};

const formatFieldValue = (field: string, value: unknown): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'status') return ENTRY_STATUS_LABELS[String(value)] ?? String(value);
  if (field === 'plan_start_month' || field === 'period_month') return formatMonthLabel(String(value));
  if (MONEY_FIELDS.has(field)) return formatMoney(String(value));
  if (DATE_FIELDS.has(field)) return formatDate(String(value));
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return String(value);
};

const buildTitle = (entry: IObjectKpiHistoryEntry): string => {
  const entity = ENTITY_LABELS[entry.entity_kind] ?? entry.entity_kind;
  const before = entry.before_data?.status;
  const after = entry.after_data?.status;
  if (entry.action === 'update' && after && before !== after) {
    const verb = STATUS_ACTIONS[String(after)];
    if (verb) return `${entity} ${verb}`;
  }
  return `${entity} ${ACTION_LABELS[entry.action] ?? entry.action}`;
};

interface IProps {
  entries: IObjectKpiHistoryEntry[];
  isLoading: boolean;
}

export const ObjectKpiHistoryList: FC<IProps> = ({ entries, isLoading }) => {
  if (isLoading) return <p className={styles.empty}>Загрузка…</p>;
  if (entries.length === 0) return <p className={styles.empty}>Изменений нет</p>;

  return (
    <div className={styles.list}>
      {entries.map(entry => {
        // Статус показан в заголовке — в списке полей он был бы дублем; служебные поля
        // снимка человеку не нужны вовсе.
        const fields = entry.changed_fields.filter(
          field => field !== 'status' && !TECHNICAL_FIELDS.has(field),
        );
        return (
          <div key={entry.id} className={styles.item}>
            <div className={styles.head}>
              <span className={styles.action}>{buildTitle(entry)}</span>
              <span className={styles.meta}>
                {new Date(entry.changed_at).toLocaleString('ru-RU')}
                {entry.changed_by_name ? ` · ${formatFioShort(entry.changed_by_name)}` : ''}
              </span>
            </div>

            {fields.length > 0 && (
              <ul className={styles.changes}>
                {fields.map(field => (
                  <li key={field}>
                    <span className={styles.fieldName}>{FIELD_LABELS[field] ?? field}:</span>
                    {' '}
                    {formatFieldValue(field, entry.before_data?.[field])}
                    <span className={styles.arrow}>→</span>
                    <strong>{formatFieldValue(field, entry.after_data?.[field])}</strong>
                  </li>
                ))}
              </ul>
            )}

            {entry.reason && (
              <div className={styles.reason}>Основание: {entry.reason}</div>
            )}
          </div>
        );
      })}
    </div>
  );
};
