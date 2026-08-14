import { useState, type FC, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { ModalShell } from '../ui/ModalShell';
import { objectKpiApi, type IObjectContract } from '../../api/objectKpi';
import { objectKpiKeys } from '../../api/queryKeys';
import { useToast } from '../../contexts/ToastContext';
import { formatDate, formatMoney, formatMonthLabel, formatPercent } from '../../utils/formatMoney';
import styles from './ObjectKpiCardModal.module.css';

/**
 * Карточка объекта: договор и ЗОС, допсоглашения, акты КС-2, месячный план, история.
 *
 * Правка доступна только при can_edit на вкладку. Подписанные записи не редактируются —
 * их аннулируют и заводят заново (правило жизненного цикла, см. object-kpi.service.ts).
 */

interface IProps {
  objectId: string;
  period: { from: string; to: string };
  canEdit: boolean;
  onClose: () => void;
}

type Tab = 'contract' | 'addenda' | 'ks2' | 'plans' | 'history';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'contract', label: 'Договор и ЗОС' },
  { key: 'addenda', label: 'Допсоглашения' },
  { key: 'ks2', label: 'КС-2' },
  { key: 'plans', label: 'План месяца' },
  { key: 'history', label: 'История' },
];

const errorText = (error: unknown): string =>
  (error as { data?: { error?: string } })?.data?.error
  ?? (error as Error)?.message
  ?? 'Не удалось сохранить';

export const ObjectKpiCardModal: FC<IProps> = ({ objectId, period, canEdit, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('contract');

  const cardQuery = useQuery({
    queryKey: objectKpiKeys.card(objectId, period.from, period.to),
    queryFn: () => objectKpiApi.getCard(objectId, period),
  });

  const historyQuery = useQuery({
    queryKey: objectKpiKeys.history(objectId),
    queryFn: () => objectKpiApi.getHistory(objectId),
    enabled: tab === 'history',
  });

  const card = cardQuery.data;
  const contract = card?.contract ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: objectKpiKeys.all });
  };

  const contractMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => (
      contract
        ? objectKpiApi.updateContract(contract.id, { ...payload, version: contract.version })
        : objectKpiApi.createContract(objectId, payload)
    ),
    onSuccess: () => { toast.success('Договор сохранён'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  const addendumMutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      objectKpiApi.createAddendum(contract!.id, payload),
    onSuccess: () => { toast.success('Допсоглашение добавлено'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  const ks2Mutation = useMutation({
    mutationFn: (payload: Record<string, unknown>) => objectKpiApi.createKs2(contract!.id, payload),
    onSuccess: () => { toast.success('Акт добавлен'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  const statusMutation = useMutation({
    mutationFn: async (
      args: { kind: 'addendum' | 'ks2'; id: string; version: number; sign: boolean; reason?: string },
    ): Promise<void> => {
      if (args.kind === 'addendum') {
        if (args.sign) await objectKpiApi.signAddendum(args.id, args.version, args.reason);
        else await objectKpiApi.cancelAddendum(args.id, args.version, args.reason);
        return;
      }
      if (args.sign) await objectKpiApi.signKs2(args.id, args.version, args.reason);
      else await objectKpiApi.cancelKs2(args.id, args.version, args.reason);
    },
    onSuccess: () => { toast.success('Статус изменён'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  const fixMutation = useMutation({
    mutationFn: (periodMonth: string) => objectKpiApi.fixPlan(objectId, periodMonth),
    onSuccess: () => { toast.success('План зафиксирован'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  /** Смена статуса записи закрытого месяца требует основания — спрашиваем сразу. */
  const askReason = (): string | null => window.prompt('Основание (обязательно для закрытого месяца):') ?? null;

  const submitContract = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => {
      const raw = form.get(key);
      return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
    };

    contractMutation.mutate({
      contract_number: value('contract_number'),
      contract_date: value('contract_date'),
      customer_name: value('customer_name'),
      base_amount: value('base_amount') ?? '0',
      planned_zos_date: value('planned_zos_date'),
      actual_zos_date: value('actual_zos_date'),
      plan_start_month: value('plan_start_month'),
      notes: value('notes'),
      reason: value('reason'),
    });
  };

  const renderContract = (data: IObjectContract | null) => (
    <form className={styles.form} onSubmit={submitContract}>
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
          <input name="base_amount" inputMode="decimal" defaultValue={data?.base_amount ?? ''} disabled={!canEdit} />
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
          <span>Первый расчётный месяц</span>
          <input type="date" name="plan_start_month" defaultValue={data?.plan_start_month ?? ''} disabled={!canEdit} />
        </label>
        <label className={styles.field}>
          <span>Основание правки</span>
          <input name="reason" placeholder="нужно для закрытых месяцев" disabled={!canEdit} />
        </label>
      </div>

      <label className={styles.field}>
        <span>Примечание</span>
        <textarea name="notes" rows={2} defaultValue={data?.notes ?? ''} disabled={!canEdit} />
      </label>

      {canEdit && (
        <button type="submit" className={styles.primaryBtn} disabled={contractMutation.isPending}>
          {data ? 'Сохранить договор' : 'Создать договор'}
        </button>
      )}
    </form>
  );

  const renderAddenda = () => (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Номер</th><th>Дата</th><th>Действует с</th><th>Сумма</th><th>Статус</th><th /></tr>
          </thead>
          <tbody>
            {(card?.addenda ?? []).map(item => (
              <tr key={item.id}>
                <td>{item.addendum_number}</td>
                <td>{formatDate(item.addendum_date)}</td>
                <td>{formatDate(item.effective_date)}</td>
                <td>{formatMoney(item.amount_delta)}</td>
                <td>{item.status === 'signed' ? 'подписано' : item.status === 'cancelled' ? 'аннулировано' : 'черновик'}</td>
                <td className={styles.actions}>
                  {canEdit && item.status === 'draft' && (
                    <button type="button" onClick={() => statusMutation.mutate({
                      kind: 'addendum', id: item.id, version: item.version, sign: true,
                      reason: askReason() ?? undefined,
                    })}>Подписать</button>
                  )}
                  {canEdit && item.status === 'signed' && (
                    <button type="button" onClick={() => statusMutation.mutate({
                      kind: 'addendum', id: item.id, version: item.version, sign: false,
                      reason: askReason() ?? undefined,
                    })}>Аннулировать</button>
                  )}
                </td>
              </tr>
            ))}
            {(card?.addenda ?? []).length === 0 && (
              <tr><td colSpan={6} className={styles.empty}>Допсоглашений нет</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {canEdit && contract && (
        <form
          className={styles.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            addendumMutation.mutate({
              addendum_number: String(form.get('addendum_number') ?? '').trim(),
              addendum_date: form.get('addendum_date'),
              effective_date: form.get('effective_date'),
              amount_delta: form.get('amount_delta'),
            });
            event.currentTarget.reset();
          }}
        >
          <input name="addendum_number" placeholder="Номер ДС" required />
          <input type="date" name="addendum_date" required />
          <input type="date" name="effective_date" required />
          <input name="amount_delta" inputMode="decimal" placeholder="Сумма (± ₽)" required />
          <button type="submit" className={styles.primaryBtn}>Добавить</button>
        </form>
      )}
    </>
  );

  const renderKs2 = () => (
    <>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Номер акта</th><th>Подписан заказчиком</th><th>Месяц</th><th>Вид</th>
              <th>Сумма</th><th>Статус</th><th /></tr>
          </thead>
          <tbody>
            {(card?.ks2 ?? []).map(item => (
              <tr key={item.id}>
                <td>{item.act_number}</td>
                <td>{formatDate(item.customer_signed_date)}</td>
                <td>{formatMonthLabel(item.period_month)}</td>
                <td>{item.entry_kind === 'act' ? 'КС-2' : 'уменьшение'}</td>
                <td>{formatMoney(item.amount)}</td>
                <td>{item.status === 'signed' ? 'подписан' : item.status === 'cancelled' ? 'аннулирован' : 'черновик'}</td>
                <td className={styles.actions}>
                  {canEdit && item.status === 'draft' && (
                    <button type="button" onClick={() => statusMutation.mutate({
                      kind: 'ks2', id: item.id, version: item.version, sign: true,
                      reason: askReason() ?? undefined,
                    })}>Подписать</button>
                  )}
                  {canEdit && item.status === 'signed' && (
                    <button type="button" onClick={() => statusMutation.mutate({
                      kind: 'ks2', id: item.id, version: item.version, sign: false,
                      reason: askReason() ?? undefined,
                    })}>Аннулировать</button>
                  )}
                </td>
              </tr>
            ))}
            {(card?.ks2 ?? []).length === 0 && (
              <tr><td colSpan={7} className={styles.empty}>Актов нет</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {canEdit && contract && (
        <form
          className={styles.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            ks2Mutation.mutate({
              entry_kind: form.get('entry_kind'),
              act_number: String(form.get('act_number') ?? '').trim(),
              customer_signed_date: form.get('customer_signed_date'),
              // Сумма всегда положительная: знак уменьшения ставит бэкенд по entry_kind.
              amount: form.get('amount'),
            });
            event.currentTarget.reset();
          }}
        >
          <select name="entry_kind" defaultValue="act">
            <option value="act">КС-2</option>
            <option value="reduction">Уменьшение объёма</option>
          </select>
          <input name="act_number" placeholder="Номер акта" required />
          <input type="date" name="customer_signed_date" required />
          <input name="amount" inputMode="decimal" placeholder="Сумма, ₽" required />
          <button type="submit" className={styles.primaryBtn}>Добавить</button>
        </form>
      )}
    </>
  );

  const renderPlans = () => (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Месяц</th><th>Остаток</th><th>Мес.</th><th>План</th><th>Факт</th>
            <th>%</th><th>Статус</th><th /></tr>
        </thead>
        <tbody>
          {(card?.report ?? []).map(row => {
            const plan = card?.plans.find(p => p.period_month === row.period_month && p.is_current);
            return (
              <tr key={row.period_month}>
                <td>{formatMonthLabel(row.period_month)}</td>
                <td>{formatMoney(row.remainder)}</td>
                <td>{row.months_remaining ?? '—'}</td>
                <td>
                  {formatMoney(row.plan_amount)}
                  {row.plan_overridden && <span className={styles.mark} title="Задан вручную">✎</span>}
                </td>
                <td>{formatMoney(row.fact_amount)}</td>
                <td>{formatPercent(row.completion_pct)}</td>
                <td>
                  {row.report_status}
                  {plan && plan.revision > 1 && <span className={styles.mark}>ревизия {plan.revision}</span>}
                </td>
                <td className={styles.actions}>
                  {canEdit && row.report_status === 'open' && (
                    <button type="button" onClick={() => fixMutation.mutate(row.period_month)}>
                      Зафиксировать
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
          {(card?.report ?? []).length === 0 && (
            <tr><td colSpan={8} className={styles.empty}>Нет расчётных месяцев в периоде</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const renderHistory = () => (
    <div className={styles.history}>
      {historyQuery.isLoading && <p className={styles.empty}>Загрузка…</p>}
      {(historyQuery.data ?? []).map(entry => (
        <div key={entry.id} className={styles.historyRow}>
          <span className={styles.historyDate}>
            {new Date(entry.changed_at).toLocaleString('ru-RU')}
          </span>
          <span>{entry.entity_kind} · {entry.action}</span>
          <span className={styles.historyFields}>{entry.changed_fields.join(', ') || '—'}</span>
          <span>{entry.changed_by_name ?? '—'}</span>
          {entry.reason && <span className={styles.historyReason}>{entry.reason}</span>}
        </div>
      ))}
      {historyQuery.isSuccess && (historyQuery.data ?? []).length === 0 && (
        <p className={styles.empty}>Изменений нет</p>
      )}
    </div>
  );

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.container}>
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <span className={styles.title}>
              {card?.report[0]?.object_name ?? 'Объект'}
            </span>
            <button type="button" className={styles.iconBtn} onClick={requestClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>

          <div className={styles.tabs}>
            {TABS.map(item => (
              <button
                key={item.key}
                type="button"
                className={`${styles.tab} ${tab === item.key ? styles.tabActive : ''}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className={styles.body}>
            {cardQuery.isLoading && <p className={styles.empty}>Загрузка…</p>}
            {cardQuery.isError && <p className={styles.empty}>Не удалось загрузить карточку</p>}
            {!cardQuery.isLoading && tab === 'contract' && renderContract(contract)}
            {!cardQuery.isLoading && tab === 'addenda' && (
              contract ? renderAddenda() : <p className={styles.empty}>Сначала заведите договор</p>
            )}
            {!cardQuery.isLoading && tab === 'ks2' && (
              contract ? renderKs2() : <p className={styles.empty}>Сначала заведите договор</p>
            )}
            {!cardQuery.isLoading && tab === 'plans' && renderPlans()}
            {tab === 'history' && renderHistory()}
          </div>
        </>
      )}
    </ModalShell>
  );
};
