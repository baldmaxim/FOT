import type { FC, FormEvent } from 'react';

import type { IObjectContract } from '../../api/objectKpi';
import { formatMoneyInput, toMoneyInput } from '../../utils/moneyInput';
import styles from './ObjectKpiCardModal.module.css';

/**
 * Форма договора и ЗОС. Неуправляемая (defaultValue + FormData на сабмите): значения
 * приходят одним объектом из карточки, и держать под каждое поле состояние незачем.
 */

interface IProps {
  data: IObjectContract | null;
  canEdit: boolean;
  formId: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onInput: () => void;
}

export const ObjectKpiContractForm: FC<IProps> = ({ data, canEdit, formId, onSubmit, onInput }) => (
  <form id={formId} className={styles.form} onSubmit={onSubmit} onInput={onInput}>
    <div className={styles.grid}>
      <label className={styles.field}>
        <span>Номер договора</span>
        <input name="contract_number" defaultValue={data?.contract_number ?? ''} disabled={!canEdit} />
      </label>
      <label className={styles.field}>
        <span>Дата договора</span>
        <input type="date" name="contract_date" defaultValue={data?.contract_date ?? ''} disabled={!canEdit} />
      </label>
      <label className={styles.field}>
        <span>Заказчик</span>
        <input name="customer_name" defaultValue={data?.customer_name ?? ''} disabled={!canEdit} />
      </label>
      <label className={styles.field}>
        <span>Стоимость договора, ₽ (с НДС)</span>
        <input
          name="base_amount"
          inputMode="decimal"
          defaultValue={toMoneyInput(data?.base_amount)}
          disabled={!canEdit}
          onChange={(event) => { event.target.value = formatMoneyInput(event.target.value); }}
        />
      </label>
      <label className={styles.field}>
        <span>Плановая ЗОС</span>
        <input type="date" name="planned_zos_date" defaultValue={data?.planned_zos_date ?? ''} disabled={!canEdit} />
      </label>
      <label className={styles.field}>
        <span>Фактическая ЗОС</span>
        <input type="date" name="actual_zos_date" defaultValue={data?.actual_zos_date ?? ''} disabled={!canEdit} />
      </label>
      <label className={styles.field}>
        {/* Именно месяц: в БД на колонке CHECK «день = 1». */}
        <span>Первый расчётный месяц</span>
        <input
          type="month"
          name="plan_start_month"
          defaultValue={data?.plan_start_month?.slice(0, 7) ?? ''}
          disabled={!canEdit}
        />
        {/* Иначе месяцы до первого акта висят в отчёте с планом и нулевым фактом,
            и выглядит это как провал KPI, а не как «объект ещё не начинался». */}
        <span className={styles.hint}>Месяцы до него в отчёт и в расчёт премии не попадают</span>
      </label>
      <label className={styles.field}>
        {/* Точка отсчёта вместо истории актов: иначе верный остаток требует завести КС-2
            за каждый прошедший месяц объекта. Пусто — считаем по КС-2, как обычно. */}
        <span>Остаток на первый расчётный месяц, ₽</span>
        <input
          name="opening_remainder"
          inputMode="decimal"
          defaultValue={toMoneyInput(data?.opening_remainder)}
          disabled={!canEdit}
          onChange={(event) => { event.target.value = formatMoneyInput(event.target.value); }}
        />
        <span className={styles.hint}>Задан — КС-2 за месяцы до него в расчёт не берутся</span>
      </label>
    </div>

    <label className={styles.field}>
      <span>Примечание</span>
      <textarea name="notes" rows={2} defaultValue={data?.notes ?? ''} disabled={!canEdit} />
    </label>
  </form>
);
