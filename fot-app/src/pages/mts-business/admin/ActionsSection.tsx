import { type FC, useState } from 'react';
import { useMtsBusinessAccounts, useMtsBusinessImportedNumbers } from '../../../hooks/useMtsBusinessData';
import {
  useMtsBusinessActions,
  useMtsBusinessBudgetRules,
  useModifyMtsBusinessService,
  useAddMtsBusinessBudgetRule,
  useRemoveMtsBusinessBudgetRule,
} from '../../../hooks/useMtsBusinessActionsData';
import type { IMtsBusinessBudgetRule } from '../../../services/mtsBusinessActionsService';
import { SubscriberCardModal } from '../SubscriberCardModal';
import { errText, fmtLast, ACTION_TYPE_LABELS } from '../mtsBusinessFormat';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  completed: { cls: styles.badgeOk, label: 'готово' },
  in_progress: { cls: styles.badgeWait, label: 'в обработке' },
  faulted: { cls: styles.badgeErr, label: 'ошибка' },
  unknown: { cls: styles.badgeMuted, label: '—' },
};

/** Управление услугами, блокировками и корпоративным бюджетом (асинхронные заявки). */
export const ActionsSection: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const imported = useMtsBusinessImportedNumbers(true);
  const actions = useMtsBusinessActions(true);
  const modifyService = useModifyMtsBusinessService();
  const addRule = useAddMtsBusinessBudgetRule();
  const removeRule = useRemoveMtsBusinessBudgetRule();

  const [accountId, setAccountId] = useState('');
  const [msisdn, setMsisdn] = useState('');
  const [externalID, setExternalID] = useState('');
  const [kind, setKind] = useState<'service' | 'block'>('service');
  const [ruleProductCode, setRuleProductCode] = useState('');
  const [ruleVersionId, setRuleVersionId] = useState('');
  const [ruleLimit, setRuleLimit] = useState('');
  const [cardOpen, setCardOpen] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const rules = useMtsBusinessBudgetRules(accountId, msisdn, Boolean(accountId && msisdn));
  const active = (accounts.data ?? []).filter(a => a.isActive);
  const numbers = (imported.data ?? []).filter(r => r.msisdn);

  const onModify = async (mode: 'add' | 'remove'): Promise<void> => {
    setMsg(null);
    if (!accountId || !msisdn || !externalID.trim()) { setMsg({ ok: false, text: 'Укажите лицевой счёт, номер и код услуги/блокировки' }); return; }
    try {
      const r = await modifyService.mutateAsync({ accountId, msisdn, externalID: externalID.trim(), kind, mode });
      setMsg({ ok: true, text: `Заявка отправлена, eventId: ${r.eventId}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка (возможно нужен 2FA)') });
    }
  };

  const onAddRule = async (): Promise<void> => {
    setMsg(null);
    if (!accountId || !msisdn || !ruleProductCode.trim() || !ruleVersionId.trim()) { setMsg({ ok: false, text: 'Укажите код и версию правила' }); return; }
    try {
      const r = await addRule.mutateAsync({ accountId, msisdn, productCode: ruleProductCode.trim(), productVersionId: ruleVersionId.trim(), limitValue: ruleLimit.trim() || undefined });
      setMsg({ ok: true, text: `Заявка отправлена, eventId: ${r.eventId}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка (возможно нужен 2FA)') });
    }
  };

  const onRemoveRule = async (rule: IMtsBusinessBudgetRule): Promise<void> => {
    if (!accountId || !msisdn || !rule.productCode || !rule.productVersionId) return;
    setMsg(null);
    try {
      const r = await removeRule.mutateAsync({ accountId, msisdn, productCode: rule.productCode, productVersionId: rule.productVersionId });
      setMsg({ ok: true, text: `Заявка на удаление отправлена, eventId: ${r.eventId}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка (возможно нужен 2FA)') });
    }
  };

  return (
    <>
      <p className={styles.hint}>
        Асинхронные операции — статус появится в таблице заявок ниже. Коды услуг (PEXXXX), блокировок (BLXXXX) и правил
        бюджета (CB.RULE.XXXXX) вводятся вручную, как в личном кабинете МТС.
      </p>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Лицевой счёт</label>
          <select className={styles.select} value={accountId} onChange={e => setAccountId(e.target.value)}>
            <option value="">— выберите —</option>
            {active.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Номер</label>
          <select className={styles.select} value={msisdn} onChange={e => setMsisdn(e.target.value)}>
            <option value="">— выберите —</option>
            {numbers.map(r => (
              <option key={r.msisdn} value={r.msisdn as string}>
                {r.msisdn}{r.employeeFullName ? ` — ${r.employeeFullName}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Карточка номера</label>
          <button className={styles.btnSecondary} disabled={!msisdn} onClick={() => setCardOpen(true)}>Открыть карточку</button>
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>Тип</label>
          <select className={styles.select} value={kind} onChange={e => setKind(e.target.value as 'service' | 'block')}>
            <option value="service">Услуга (PEXXXX)</option>
            <option value="block">Добровольная блокировка (BLXXXX)</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Код</label>
          <input className={styles.input} value={externalID} onChange={e => setExternalID(e.target.value)} placeholder="PE1234 / BL0005" />
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={() => onModify('add')} disabled={modifyService.isPending}>Добавить</button>
        <button className={styles.btnSecondary} onClick={() => onModify('remove')} disabled={modifyService.isPending}>Удалить</button>
      </div>

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 16 }}>Правила корпоративного бюджета выбранного номера</h3>
      {rules.isLoading && accountId && msisdn ? <p className={styles.hint}>Загрузка…</p> : null}
      {(rules.data ?? []).length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Правило</th><th>Лимит</th><th>Действует с</th><th></th></tr></thead>
            <tbody>
              {(rules.data ?? []).map((r, i) => (
                <tr key={`${r.productCode ?? 'rule'}-${i}`}>
                  <td>{r.title ?? r.productCode ?? '—'}</td>
                  <td>{r.limitValue ?? '—'}</td>
                  <td>{r.activeFrom ?? '—'}</td>
                  <td><button className={styles.btnSecondary} onClick={() => { void onRemoveRule(r); }} disabled={removeRule.isPending}>Удалить</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className={styles.row} style={{ marginTop: 8 }}>
        <div className={styles.field}>
          <label className={styles.label}>Код правила</label>
          <input className={styles.input} value={ruleProductCode} onChange={e => setRuleProductCode(e.target.value)} placeholder="CB.RULE.XXXXX" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Версия правила</label>
          <input className={styles.input} value={ruleVersionId} onChange={e => setRuleVersionId(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Лимит (необязательно)</label>
          <input className={styles.input} value={ruleLimit} onChange={e => setRuleLimit(e.target.value)} placeholder="1000" />
        </div>
      </div>
      <div className={styles.actions}>
        <button className={styles.btn} onClick={() => { void onAddRule(); }} disabled={addRule.isPending}>Добавить правило</button>
      </div>

      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}

      <h3 className={styles.cardTitle} style={{ fontSize: 14, marginTop: 16 }}>Заявки на управляющие действия</h3>
      {(actions.data ?? []).length === 0 ? (
        <p className={styles.hint}>Заявок нет.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Действие</th><th>Статус</th><th>Отправлено</th><th>Проверено</th></tr></thead>
            <tbody>
              {(actions.data ?? []).map(a => {
                const badge = STATUS_BADGE[a.status] ?? STATUS_BADGE.unknown;
                return (
                  <tr key={a.eventId}>
                    <td>{ACTION_TYPE_LABELS[a.actionType] ?? a.actionType}</td>
                    <td><span className={`${styles.badge} ${badge.cls}`}>{badge.label}</span></td>
                    <td>{fmtLast(a.requestedAt)}</td>
                    <td>{fmtLast(a.checkedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cardOpen && msisdn && <SubscriberCardModal msisdn={msisdn} onClose={() => setCardOpen(false)} />}
    </>
  );
};
