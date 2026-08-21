import { useMemo, useState, type FC, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { ModalShell } from '../ui/ModalShell';
import { objectKpiApi } from '../../api/objectKpi';
import { objectKpiKeys } from '../../api/queryKeys';
import { useToast } from '../../contexts/ToastContext';
import { parseMoneyInput } from '../../utils/moneyInput';
import { moscowCurrentMonth } from '../../utils/moscowDate';
import { ObjectKpiContractForm } from './ObjectKpiContractForm';
import { ObjectKpiEntriesTab, type IEntryColumn, type IEntryRow } from './ObjectKpiEntriesTab';
import { ObjectKpiEntryAddForm } from './ObjectKpiEntryAddForm';
import { ObjectKpiHistoryList } from './ObjectKpiHistoryList';
import { ObjectKpiPlansTab, type PlanDraft } from './ObjectKpiPlansTab';
import styles from './ObjectKpiCardModal.module.css';

/**
 * Карточка объекта: договор и ЗОС, допсоглашения, КС-2, месячный план, история.
 *
 * Вкладки КС-6 нет намеренно: в отчёте «КС-6» — накопительный итог подписанных КС-2,
 * то есть производная от актов; ручной ввод той же величины дал бы второе, расходящееся
 * число. Реестр object_ks6_entries на сервере остался нетронутым.
 *
 * У КС-2 правятся месяц и сумма — в том числе у ПОДПИСАННОЙ записи: ошибочный месяц иначе
 * исправлялся бы аннулированием и повторным заведением каждой строки. Остальные поля
 * подписанной записи сервер блокирует (signed_field_locked), и набор колонок с
 * editableWhenSigned совпадает с этим белым списком.
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

const ADDENDA_COLUMNS: IEntryColumn[] = [
  { key: 'addendum_number', label: '№', kind: 'text' },
  { key: 'addendum_date', label: 'Дата', kind: 'date' },
  { key: 'amount_delta', label: 'Сумма', kind: 'money', allowNegative: true },
];

const KS2_COLUMNS: IEntryColumn[] = [
  { key: 'act_number', label: '№', kind: 'text' },
  // Месяц и сумма — ровно то, что сервер разрешает править у подписанной записи.
  { key: 'period_month', label: 'Месяц', kind: 'month', editableWhenSigned: true },
  {
    key: 'entry_kind',
    label: 'Вид',
    kind: 'readonly',
    render: (row) => (row.entry_kind === 'act' ? 'КС-2' : 'уменьшение'),
  },
  {
    key: 'amount',
    label: 'Сумма',
    kind: 'money',
    editableWhenSigned: true,
    // Комментарий живёт в notes записи и правится вместе с суммой: пояснение к правке
    // должно стоять там же, где сама правка, а не отдельной сущностью в «Плане месяца».
    secondary: { key: 'notes', placeholder: 'Комментарий', editableWhenSigned: true },
  },
];

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
  const [planEdits, setPlanEdits] = useState<PlanDraft>({});
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

  const fixMutation = useMutation({
    mutationFn: (periodMonth: string) => objectKpiApi.fixPlan(objectId, periodMonth),
    onSuccess: () => { toast.success('План зафиксирован'); refresh(); },
    onError: (error) => toast.error(errorText(error)),
  });

  const currentMonth = moscowCurrentMonth();

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
      // Пустое поле — это null («считать по КС-2»), а не ноль («всё закрыто»).
      opening_remainder: parseMoneyInput(String(form.get('opening_remainder') ?? '')),
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

    // Основание спрашивается ОДИН раз на пачку и только когда правится подписанная запись
    // в объекте с закрытыми месяцами. Отказ отменяет всё сохранение целиком: иначе часть
    // строк уехала бы на сервер и упала там с reason_required.
    let reason: string | undefined;
    const touchesSigned = ids.some(id => rows.find(row => row.id === id)?.status === 'signed');
    if (touchesSigned && card?.has_fixed_months) {
      const answer = window.prompt('Основание правки (у объекта есть закрытые месяцы):');
      if (answer === null || answer.trim() === '') {
        toast.error('Правка отменена: без основания подписанную запись сохранить нельзя');
        return;
      }
      reason = answer.trim();
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
      if (reason) payload.reason = reason;

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

  const addFormFor = (kind: 'addenda' | 'ks2') => (
    canEdit && contract ? (
      <ObjectKpiEntryAddForm
        kind={kind}
        maxMonth={currentMonth}
        pending={addMutation.isPending}
        onSubmit={(payload) => addMutation.mutate({ kind, payload })}
      />
    ) : null
  );

  const entriesTab = (kind: 'addenda' | 'ks2', columns: IEntryColumn[], rows: IEntryRow[], emptyText: string) => (
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
            {isCreate && (
              <ObjectKpiContractForm
                data={null}
                canEdit={canEdit}
                formId={CONTRACT_FORM_ID}
                onSubmit={submitContract}
                onInput={() => setContractDirty(true)}
              />
            )}
            {!isCreate && cardQuery.isLoading && <p className={styles.empty}>Загрузка…</p>}
            {!isCreate && cardQuery.isError && (
              <p className={styles.empty}>Не удалось загрузить карточку</p>
            )}
            {!isCreate && !cardQuery.isLoading && tab === 'contract' && (
              <ObjectKpiContractForm
                data={contract}
                canEdit={canEdit}
                formId={CONTRACT_FORM_ID}
                onSubmit={submitContract}
                onInput={() => setContractDirty(true)}
              />
            )}
            {!isCreate && !cardQuery.isLoading && tab === 'addenda'
              && entriesTab('addenda', ADDENDA_COLUMNS, addenda, 'Допсоглашений нет')}
            {!isCreate && !cardQuery.isLoading && tab === 'ks2'
              && entriesTab('ks2', KS2_COLUMNS, ks2, 'Актов нет')}
            {!isCreate && !cardQuery.isLoading && tab === 'plans' && (
              <ObjectKpiPlansTab
                card={card}
                canEdit={canEdit}
                canRevisePlan={canRevisePlan}
                planEdits={planEdits}
                setPlanEdits={setPlanEdits}
                onFixMonth={(month) => fixMutation.mutate(month)}
              />
            )}
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
