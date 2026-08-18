import { useMemo, useState, type FC, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { ModalShell } from '../ui/ModalShell';
import { objectKpiApi, type IObjectContract } from '../../api/objectKpi';
import { objectKpiKeys } from '../../api/queryKeys';
import { useToast } from '../../contexts/ToastContext';
import { formatDate, formatMoney, formatMonthLabel, formatPercent } from '../../utils/formatMoney';
import { formatMoneyInput, parseMoneyInput, toMoneyInput } from '../../utils/moneyInput';
import { moscowCurrentMonth } from '../../utils/moscowDate';
import { ObjectKpiEntriesTab, type IEntryColumn, type IEntryRow } from './ObjectKpiEntriesTab';
import { ObjectKpiHistoryList } from './ObjectKpiHistoryList';
import styles from './ObjectKpiCardModal.module.css';

/**
 * Карточка объекта: договор и ЗОС, допсоглашения, КС-2, месячный план, история.
 *
 * Вкладки КС-6 нет намеренно: в отчёте «КС-6» — накопительный итог подписанных КС-2,
 * то есть производная от актов; ручной ввод той же величины дал бы второе, расходящееся
 * число. Реестр object_ks6_entries на сервере остался нетронутым.
 *
 * Подписанные записи не редактируются — их аннулируют и заводят заново (правило
 * жизненного цикла, см. object-kpi.service.ts). Кнопка «Сохранить» в футере применяет
 * ровно то, что изменено на текущей вкладке.
 */

interface IProps {
  objectId: string;
  /**
   * `create` — заведение нового договора: карточка не грузится вообще и показывает только
   * пустую форму договора. Иначе на соседних вкладках всплыли бы ДС, акты и планы уже
   * существующего договора, что противоречит смыслу действия.
   */
  mode: 'view' | 'create';
  /** Нужен именно в create: заголовок брать неоткуда — отчёт объекта не загружается. */
  objectName: string;
  /** Без периода карточка показывает весь расчёт по объекту — окно считает сервер. */
  period?: { from: string; to: string };
  canEdit: boolean;
  /** Право пересматривать зафиксированный план (руководитель эк. отдела или админ). */
  canRevisePlan: boolean;
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

const CONTRACT_FORM_ID = 'object-kpi-contract-form';

/** Серверный текст ошибки лежит в ApiError.message (client.ts кладёт туда body.error). */
const errorText = (error: unknown): string =>
  (error as Error)?.message || 'Не удалось сохранить';

export const ObjectKpiCardModal: FC<IProps> = ({
  objectId, mode, objectName, period, canEdit, canRevisePlan, onClose,
}) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const isCreate = mode === 'create';
  const [tab, setTab] = useState<Tab>('contract');
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [planEdits, setPlanEdits] = useState<Record<string, { amount: string; reason: string }>>({});
  /** Правка факта месяца: целевая сумма и причина; сервер заведёт акт на разницу. */
  const [factEdit, setFactEdit] = useState<{ month: string; amount: string; reason: string } | null>(null);
  const [contractDirty, setContractDirty] = useState(false);
  const [contractReason, setContractReason] = useState('');
  const [saving, setSaving] = useState(false);

  // В режиме создания карточка не запрашивается вовсе: форма нового договора не должна
  // ждать отчёт за весь срок объекта.
  const cardQuery = useQuery({
    queryKey: objectKpiKeys.card(objectId, period?.from ?? 'auto', period?.to ?? 'auto'),
    queryFn: () => objectKpiApi.getCard(objectId, period),
    enabled: !isCreate,
  });

  const historyQuery = useQuery({
    queryKey: objectKpiKeys.history(objectId),
    queryFn: () => objectKpiApi.getHistory(objectId),
    enabled: !isCreate && tab === 'history',
  });

  const card = cardQuery.data;
  const contract = card?.contract ?? null;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: objectKpiKeys.all });
  };

  const setEdit = (id: string, key: string, value: string) => {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
  };

  const contractMutation = useMutation({
    // Выбор по mode, а не по наличию contract: в режиме создания карточка не загружена,
    // и «нет договора в состоянии» не должно означать «его нет в базе».
    mutationFn: (payload: Record<string, unknown>) => (
      !isCreate && contract
        ? objectKpiApi.updateContract(contract.id, { ...payload, version: contract.version })
        : objectKpiApi.createContract(objectId, payload)
    ),
    onSuccess: () => {
      toast.success(isCreate ? 'Договор создан' : 'Договор сохранён');
      setContractDirty(false);
      setContractReason('');
      refresh();
      if (isCreate) onClose();
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const addMutation = useMutation({
    mutationFn: async (args: { kind: Tab; payload: Record<string, unknown> }): Promise<void> => {
      if (args.kind === 'addenda') await objectKpiApi.createAddendum(contract!.id, args.payload);
      else await objectKpiApi.createKs2(contract!.id, args.payload);
    },
    onSuccess: () => { toast.success('Запись добавлена'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  const statusMutation = useMutation({
    mutationFn: async (
      args: { kind: Tab; id: string; version: number; sign: boolean; reason?: string },
    ): Promise<void> => {
      if (args.kind === 'addenda') {
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

  const factMutation = useMutation({
    mutationFn: (args: { periodMonth: string; amount: string; reason: string }) =>
      objectKpiApi.adjustMonthFact(objectId, args.periodMonth, {
        target_amount: args.amount,
        reason: args.reason,
      }),
    onSuccess: () => {
      toast.success('Факт скорректирован актом КС-2');
      setFactEdit(null);
      refresh();
    },
    onError: (error) => toast.error(errorText(error)),
  });

  const fixMutation = useMutation({
    mutationFn: (periodMonth: string) => objectKpiApi.fixPlan(objectId, periodMonth),
    onSuccess: () => { toast.success('План зафиксирован'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  const currentMonth = moscowCurrentMonth();

  /** Причина последней корректировки факта по месяцам — из записей КС-2, а не из notes «наугад». */
  const factAdjustments = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of card?.ks2 ?? []) {
      if (entry.source === 'fact_adjustment' && entry.status !== 'cancelled' && entry.notes) {
        map.set(entry.period_month, entry.notes);
      }
    }
    return map;
  }, [card?.ks2]);

  /** Основание требуется, только когда правка задевает зафиксированный месяц. */
  const askReason = (): string | undefined => {
    if (!card?.has_fixed_months) return undefined;
    return window.prompt('Основание (обязательно для закрытого месяца):') ?? undefined;
  };

  const submitContract = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const value = (key: string) => {
      const raw = form.get(key);
      return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
    };

    // Основание в футере — обязательное поле, когда у объекта есть закрытые месяцы:
    // без него сервер вернёт 400 reason_required.
    if (card?.has_fixed_months && contractReason.trim() === '') {
      toast.error('Укажите основание правки: у объекта есть зафиксированные месяцы');
      return;
    }

    contractMutation.mutate({
      contract_number: value('contract_number'),
      contract_date: value('contract_date'),
      customer_name: value('customer_name'),
      base_amount: parseMoneyInput(String(form.get('base_amount') ?? '')) ?? '0',
      planned_zos_date: value('planned_zos_date'),
      actual_zos_date: value('actual_zos_date'),
      plan_start_month: value('plan_start_month'),
      notes: value('notes'),
      reason: contractReason.trim() || null,
    });
  };

  /** Черновики вкладки сохраняются пачкой: одна упавшая строка не отменяет остальные. */
  const saveEntries = async (kind: Tab, rows: IEntryRow[]) => {
    const ids = Object.keys(edits).filter(id => rows.some(row => row.id === id));
    if (ids.length === 0) return;

    // Пустая сумма — это не «оставить как было», а незаполненное поле: ловим до запроса,
    // иначе пользователь получит невнятный текст валидации от сервера.
    const emptyAmount = ids.some(id => ['amount', 'amount_delta'].some(key => (
      edits[id][key] !== undefined && parseMoneyInput(edits[id][key]) === null
    )));
    if (emptyAmount) {
      toast.error('Укажите сумму');
      return;
    }

    setSaving(true);
    const results = await Promise.allSettled(ids.map(async (id) => {
      const row = rows.find(item => item.id === id)!;
      const patch = edits[id];
      const payload: Record<string, unknown> = { version: row.version };

      for (const [key, raw] of Object.entries(patch)) {
        if (key === 'amount' || key === 'amount_delta') payload[key] = parseMoneyInput(raw);
        else payload[key] = raw;
      }
      // В форме ДС одна дата: дата документа она же дата вступления в силу.
      if (kind === 'addenda' && patch.addendum_date) payload.effective_date = patch.addendum_date;

      if (kind === 'addenda') await objectKpiApi.updateAddendum(id, payload);
      else await objectKpiApi.updateKs2(id, payload);
      return id;
    }));
    setSaving(false);

    const saved = new Set(
      results.flatMap(item => (item.status === 'fulfilled' ? [item.value] : [])),
    );
    const failed = results.filter(item => item.status === 'rejected');

    // Успешные строки выходят из режима правки, ошибочные остаются с прежним вводом.
    setEdits(prev => Object.fromEntries(
      Object.entries(prev).filter(([id]) => !saved.has(id)),
    ));
    if (failed.length > 0) {
      toast.error(errorText((failed[0] as PromiseRejectedResult).reason));
      if (saved.size > 0) toast.success(`Сохранено ${saved.size} из ${ids.length}`);
    } else {
      toast.success('Изменения сохранены');
    }
    refresh();
  };

  const savePlans = async () => {
    const months = Object.keys(planEdits);
    if (months.length === 0) return;
    if (months.some(month => planEdits[month].reason.trim() === '')) {
      toast.error('Укажите обоснование изменения плана');
      return;
    }

    setSaving(true);
    const results = await Promise.allSettled(months.map(async (month) => {
      await objectKpiApi.revisePlan(objectId, month, {
        reason: planEdits[month].reason.trim(),
        override_plan_amount: parseMoneyInput(planEdits[month].amount),
      });
      return month;
    }));
    setSaving(false);

    const saved = new Set(
      results.flatMap(item => (item.status === 'fulfilled' ? [item.value] : [])),
    );
    setPlanEdits(prev => Object.fromEntries(
      Object.entries(prev).filter(([month]) => !saved.has(month)),
    ));
    const failed = results.filter(item => item.status === 'rejected');
    if (failed.length > 0) toast.error(errorText((failed[0] as PromiseRejectedResult).reason));
    else toast.success('План сохранён');
    refresh();
  };

  // Мемо, а не `?? []` по месту: новый литерал каждый рендер менял бы зависимости useMemo ниже.
  const addenda = useMemo(() => (card?.addenda ?? []) as unknown as IEntryRow[], [card?.addenda]);
  const ks2 = useMemo(() => (card?.ks2 ?? []) as unknown as IEntryRow[], [card?.ks2]);

  const dirty = useMemo(() => {
    if (tab === 'contract') return contractDirty;
    if (tab === 'plans') return Object.keys(planEdits).length > 0;
    if (tab === 'history') return false;
    const rows = tab === 'addenda' ? addenda : ks2;
    return Object.keys(edits).some(id => rows.some(row => row.id === id));
  }, [tab, contractDirty, planEdits, edits, addenda, ks2]);

  const handleSave = () => {
    if (tab === 'plans') { void savePlans(); return; }
    if (tab === 'addenda') { void saveEntries('addenda', addenda); return; }
    if (tab === 'ks2') { void saveEntries('ks2', ks2); }
  };

  const ADDENDA_COLUMNS: IEntryColumn[] = [
    { key: 'addendum_number', label: '№', kind: 'text' },
    { key: 'addendum_date', label: 'Дата', kind: 'date' },
    { key: 'amount_delta', label: 'Сумма', kind: 'money', allowNegative: true },
  ];

  const KS2_COLUMNS: IEntryColumn[] = [
    { key: 'act_number', label: '№', kind: 'text' },
    {
      key: 'period_month',
      label: 'Месяц',
      kind: 'readonly',
      render: (row) => formatMonthLabel(String(row.period_month)),
    },
    {
      key: 'entry_kind',
      label: 'Вид',
      kind: 'readonly',
      render: (row) => (row.entry_kind === 'act' ? 'КС-2' : 'уменьшение'),
    },
    { key: 'amount', label: 'Сумма', kind: 'money' },
  ];

  const renderContract = (data: IObjectContract | null) => (
    <form
      id={CONTRACT_FORM_ID}
      className={styles.form}
      onSubmit={submitContract}
      onInput={() => setContractDirty(true)}
    >
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
        </label>
      </div>

      <label className={styles.field}>
        <span>Примечание</span>
        <textarea name="notes" rows={2} defaultValue={data?.notes ?? ''} disabled={!canEdit} />
      </label>
    </form>
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
            const fixed = row.report_status === 'fixed' || row.report_status === 'corrected';
            const editable = canEdit && canRevisePlan && fixed;
            const draft = planEdits[row.period_month];
            const factDraft = factEdit?.month === row.period_month ? factEdit : null;
            // Будущий месяц корректировать нечем: акт с датой подписания вперёд —
            // ошибка ввода, сервер такой запрос тоже отклонит.
            const factEditable = canEdit && row.period_month.slice(0, 7) <= currentMonth;
            return (
              <tr key={row.period_month}>
                <td>{formatMonthLabel(row.period_month)}</td>
                <td>{formatMoney(row.remainder)}</td>
                <td>{row.months_remaining ?? '—'}</td>
                <td className={styles.planCell}>
                  {draft ? (
                    <>
                      <input
                        className={styles.cellInput}
                        inputMode="decimal"
                        value={draft.amount}
                        onChange={(event) => setPlanEdits(prev => ({
                          ...prev,
                          [row.period_month]: {
                            ...prev[row.period_month],
                            amount: formatMoneyInput(event.target.value),
                          },
                        }))}
                      />
                      <input
                        className={styles.cellInput}
                        placeholder="Обоснование"
                        value={draft.reason}
                        onChange={(event) => setPlanEdits(prev => ({
                          ...prev,
                          [row.period_month]: {
                            ...prev[row.period_month],
                            reason: event.target.value,
                          },
                        }))}
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      className={editable ? styles.planValueBtn : styles.planValue}
                      disabled={!editable}
                      title={editable
                        ? 'Изменить план месяца'
                        : 'Правка доступна руководителю эк. отдела после фиксации месяца'}
                      onClick={() => setPlanEdits(prev => ({
                        ...prev,
                        [row.period_month]: {
                          amount: toMoneyInput(row.plan_amount),
                          reason: '',
                        },
                      }))}
                    >
                      {formatMoney(row.plan_amount)}
                      {row.plan_overridden && <span className={styles.mark} title="Задан вручную">✎</span>}
                    </button>
                  )}
                  {plan?.correction_reason && !draft && (
                    <span className={styles.planReason}>
                      ✎ {plan.correction_reason}
                      {plan.fixed_by_name ? ` · ${plan.fixed_by_name}` : ''}
                      {plan.fixed_at ? ` · ${formatDate(plan.fixed_at.slice(0, 10))}` : ''}
                    </span>
                  )}
                </td>
                <td className={styles.planCell}>
                  {factDraft ? (
                    <>
                      <input
                        className={styles.cellInput}
                        inputMode="decimal"
                        value={factDraft.amount}
                        onChange={(event) => setFactEdit({
                          ...factDraft,
                          amount: formatMoneyInput(event.target.value),
                        })}
                      />
                      <input
                        className={styles.cellInput}
                        placeholder="Причина корректировки"
                        value={factDraft.reason}
                        onChange={(event) => setFactEdit({ ...factDraft, reason: event.target.value })}
                      />
                      <span className={styles.factActions}>
                        <button
                          type="button"
                          onClick={() => {
                            const amount = parseMoneyInput(factDraft.amount);
                            if (amount === null) { toast.error('Укажите сумму'); return; }
                            if (factDraft.reason.trim() === '') {
                              toast.error('Укажите причину корректировки');
                              return;
                            }
                            factMutation.mutate({
                              periodMonth: row.period_month,
                              amount,
                              reason: factDraft.reason.trim(),
                            });
                          }}
                          disabled={factMutation.isPending}
                        >
                          Сохранить
                        </button>
                        <button type="button" onClick={() => setFactEdit(null)}>Отмена</button>
                      </span>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={factEditable ? styles.planValueBtn : styles.planValue}
                      disabled={!factEditable}
                      title={factEditable
                        ? 'Изменить факт: система заведёт корректирующий акт КС-2 на разницу'
                        : 'Факт будущего месяца не корректируется'}
                      onClick={() => setFactEdit({
                        month: row.period_month,
                        amount: toMoneyInput(row.fact_amount),
                        reason: '',
                      })}
                    >
                      {formatMoney(row.fact_amount)}
                    </button>
                  )}
                  {/* Причина живёт в корректирующем акте (source='fact_adjustment'),
                      поэтому переживает перезагрузку и видна во вкладке КС-2. */}
                  {!factDraft && factAdjustments.get(row.period_month) && (
                    <span className={styles.planReason}>
                      ✎ {factAdjustments.get(row.period_month)}
                    </span>
                  )}
                </td>
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

  const addFormFor = (kind: Tab) => {
    if (!canEdit || !contract) return null;
    return (
      <form
        className={styles.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const amount = parseMoneyInput(String(form.get('amount') ?? ''));

          if (kind === 'addenda') {
            const date = String(form.get('date') ?? '');
            addMutation.mutate({ kind, payload: {
              addendum_number: String(form.get('number') ?? '').trim(),
              addendum_date: date,
              // Отдельного «действует с» в форме нет: дата ДС и есть дата вступления в силу.
              effective_date: date,
              amount_delta: amount,
            } });
          } else {
            addMutation.mutate({ kind, payload: {
              entry_kind: form.get('entry_kind'),
              customer_signed_date: form.get('date'),
              // Сумма всегда положительная: знак уменьшения ставит бэкенд по entry_kind.
              amount,
            } });
          }
          event.currentTarget.reset();
        }}
      >
        {kind === 'ks2' && (
          <select name="entry_kind" defaultValue="act">
            <option value="act">КС-2</option>
            <option value="reduction">Уменьшение объёма</option>
          </select>
        )}
        {/* У КС-2 номера в форме нет: сервер берёт следующий порядковый по договору. */}
        {kind === 'addenda' && <input name="number" placeholder="Номер ДС" required />}
        <input type="date" name="date" required />
        <input
          name="amount"
          inputMode="decimal"
          placeholder={kind === 'addenda' ? 'Сумма (± ₽)' : 'Сумма, ₽'}
          required
          onChange={(event) => {
            event.target.value = formatMoneyInput(event.target.value, {
              allowNegative: kind === 'addenda',
            });
          }}
        />
        <button type="submit" className={styles.primaryBtn} disabled={addMutation.isPending}>
          Добавить
        </button>
      </form>
    );
  };

  const entriesTab = (kind: Tab, columns: IEntryColumn[], rows: IEntryRow[], emptyText: string) => (
    contract ? (
      <ObjectKpiEntriesTab
        columns={columns}
        rows={rows}
        emptyText={emptyText}
        canEdit={canEdit}
        edits={edits}
        onEditChange={setEdit}
        onSign={(row) => statusMutation.mutate({
          kind, id: row.id, version: row.version, sign: true, reason: askReason(),
        })}
        onCancel={(row) => statusMutation.mutate({
          kind, id: row.id, version: row.version, sign: false, reason: askReason(),
        })}
        addForm={addFormFor(kind)}
      />
    ) : <p className={styles.empty}>Сначала заведите договор</p>
  );

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.container}>
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <span className={styles.title}>
              {isCreate ? `${objectName} — новый договор` : (card?.report[0]?.object_name ?? objectName)}
            </span>
            <button type="button" className={styles.iconBtn} onClick={requestClose} aria-label="Закрыть">
              <X size={18} />
            </button>
          </div>

          {/* В режиме создания вкладок нет: показывать ДС и акты существующего договора,
              пока заводится новый, — прямой способ ввести человека в заблуждение. */}
          {!isCreate && (
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
          )}

          <div className={styles.body}>
            {isCreate && renderContract(null)}
            {!isCreate && cardQuery.isLoading && <p className={styles.empty}>Загрузка…</p>}
            {!isCreate && cardQuery.isError && (
              <p className={styles.empty}>Не удалось загрузить карточку</p>
            )}
            {!isCreate && !cardQuery.isLoading && tab === 'contract' && renderContract(contract)}
            {!isCreate && !cardQuery.isLoading && tab === 'addenda'
              && entriesTab('addenda', ADDENDA_COLUMNS, addenda, 'Допсоглашений нет')}
            {!isCreate && !cardQuery.isLoading && tab === 'ks2'
              && entriesTab('ks2', KS2_COLUMNS, ks2, 'Актов нет')}
            {!isCreate && !cardQuery.isLoading && tab === 'plans' && renderPlans()}
            {!isCreate && tab === 'history' && (
              <ObjectKpiHistoryList
                entries={historyQuery.data ?? []}
                isLoading={historyQuery.isLoading}
              />
            )}
          </div>

          {canEdit && (
            <div className={styles.footer}>
              {/* Основание правки — только для существующего договора с закрытыми месяцами. */}
              {!isCreate && tab === 'contract' && card?.has_fixed_months && (
                <input
                  className={styles.reasonInput}
                  placeholder="Основание правки (есть закрытые месяцы)"
                  value={contractReason}
                  onChange={(event) => setContractReason(event.target.value)}
                />
              )}
              <button
                type={isCreate || tab === 'contract' ? 'submit' : 'button'}
                form={isCreate || tab === 'contract' ? CONTRACT_FORM_ID : undefined}
                className={styles.primaryBtn}
                disabled={!dirty || saving || contractMutation.isPending}
                onClick={isCreate || tab === 'contract' ? undefined : handleSave}
              >
                {isCreate ? 'Создать договор' : 'Сохранить'}
              </button>
            </div>
          )}
        </>
      )}
    </ModalShell>
  );
};
