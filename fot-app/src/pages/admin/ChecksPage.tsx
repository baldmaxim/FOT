import { useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, RefreshCw, Loader2, Eye, CheckCircle2, XCircle, Minus, AlertTriangle, Clock } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  checksService,
  BULK_LIMIT,
  type CheckPassRow,
  type CheckStatus,
  type CheckType,
} from '../../services/checksService';
import styles from './ChecksPage.module.css';

const STATUS_LABEL: Record<CheckStatus, string> = {
  clean: 'Чисто',
  found: 'Найден',
  invalid: 'Недействителен',
  error: 'Ошибка',
  not_applicable: 'Не требуется',
  pending: 'В обработке',
};

// Иконка + цвет + aria-label (не полагаемся только на цвет/символ).
const StatusIcon: FC<{ kind: CheckType; status: CheckStatus | null; at: string | null; summary: string | null }> = ({ kind, status, at, summary }) => {
  if (!status) return <span className={styles.badgeMuted} aria-label="Не проверялось">—</span>;
  const date = at ? new Date(at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '';
  const label = kind === 'patent_msk' && status === 'clean' ? 'Патент действителен' : STATUS_LABEL[status];
  let title = summary ? `${label} · ${summary}` : label;

  let icon;
  if (status === 'clean') icon = <CheckCircle2 size={18} className={styles.icClean} aria-label={label} />;
  else if (status === 'found' || status === 'invalid') icon = <XCircle size={18} className={styles.icBad} aria-label={label} />;
  else if (status === 'pending') { icon = <Clock size={18} className={styles.icPending} aria-label={label} />; title = 'В обработке. Обновление статуса добавим после подключения polling.'; }
  else if (status === 'not_applicable') icon = <Minus size={18} className={styles.icMuted} aria-label={label} />;
  else icon = <AlertTriangle size={18} className={styles.icWarn} aria-label={label} />;

  return (
    <span className={styles.statusCell} title={title}>
      {icon}
      {date ? <span className={styles.statusDate}>{date}</span> : null}
    </span>
  );
};

export const ChecksPage: FC = () => {
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [token, setToken] = useState('');
  const [orgId, setOrgId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rawFor, setRawFor] = useState<unknown | null>(null);
  const [runningRow, setRunningRow] = useState<string | null>(null);
  const [confirmBulk, setConfirmBulk] = useState<{ ids: string[] } | null>(null);

  const settingsQuery = useQuery({
    queryKey: ['newdb', 'settings'],
    queryFn: () => checksService.getConnectionSettings(),
    staleTime: 30_000,
  });

  const orgsQuery = useQuery({
    queryKey: ['newdb', 'orgs'],
    queryFn: () => checksService.listOrgs(),
    staleTime: 60_000,
  });

  const passesQuery = useQuery({
    queryKey: ['newdb', 'passes', orgId],
    queryFn: () => checksService.listPasses(orgId),
    enabled: !!orgId,
    staleTime: 15_000,
  });

  const saveToken = useMutation({
    mutationFn: () => checksService.saveConnectionSettings({ token }),
    onSuccess: () => {
      setToken('');
      showToast('success', 'Токен сохранён');
      queryClient.invalidateQueries({ queryKey: ['newdb', 'settings'] });
    },
    onError: (e: Error) => showToast('error', e.message || 'Ошибка сохранения'),
  });

  const validate = useMutation({
    mutationFn: () => checksService.validateConnection(),
    onSuccess: (r) => {
      if (r.ok) showToast('success', `Настройки в порядке · ${r.baseUrl}`);
      else showToast('error', `Проблемы: ${r.problems.join('; ')}`);
    },
    onError: (e: Error) => showToast('error', e.message || 'Ошибка валидации'),
  });

  const runOne = useMutation({
    mutationFn: (passId: string) => checksService.run(passId, ['rkl', 'patent_msk'] as CheckType[]),
    onMutate: (passId) => setRunningRow(passId),
    onSuccess: (results) => {
      const summary = results.map(r => `${r.check_type === 'rkl' ? 'РКЛ' : 'Патент Мск'}: ${STATUS_LABEL[r.status]}`).join(' · ');
      showToast('success', summary);
      queryClient.invalidateQueries({ queryKey: ['newdb', 'passes', orgId] });
    },
    onError: (e: Error) => showToast('error', e.message || 'Ошибка проверки'),
    onSettled: () => setRunningRow(null),
  });

  const runBulk = useMutation({
    mutationFn: (ids: string[]) => checksService.runBulk(ids, ['rkl', 'patent_msk'] as CheckType[]),
    onSuccess: ({ items, skipped }) => {
      const errors = items.filter(i => i.error).length;
      let msg = `Проверено: ${items.length}`;
      if (errors) msg += ` · ошибок: ${errors}`;
      if (skipped.length) msg += ` · пропущено: ${skipped.length}`;
      showToast(errors ? 'warning' : 'success', msg);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['newdb', 'passes', orgId] });
    },
    onError: (e: Error) => showToast('error', e.message || 'Ошибка массовой проверки'),
    onSettled: () => setConfirmBulk(null),
  });

  const openLatestRaw = async (passId: string) => {
    try {
      const results = await checksService.getResults(passId);
      const latest = results.find(r => r.request_sent);
      if (!latest) { showToast('info', 'Нет отправленных проверок с ответом'); return; }
      const data = await checksService.getRaw(latest.id);
      setRawFor(data);
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const passes = passesQuery.data ?? [];
  const orgs = orgsQuery.data ?? [];

  const toggleRow = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAll = () => setSelected(prev =>
    prev.size === passes.length ? new Set() : new Set(passes.map(p => p.id)),
  );

  // «Без результата»: хотя бы один из активных статусов (РКЛ / Патент Мск)
  // реально пуст (null). pending считается результатом — не переотмечаем.
  const selectWithoutResult = () => {
    const ids = passes.filter(p => p.last_rkl_status === null || p.last_patent_msk_status === null).map(p => p.id);
    setSelected(new Set(ids.slice(0, BULK_LIMIT)));
    if (ids.length > BULK_LIMIT) showToast('info', `Отмечено первых ${BULK_LIMIT} (лимит за один прогон)`);
  };

  const startBulk = () => {
    const ids = [...selected];
    if (ids.length === 0) { showToast('info', 'Ничего не выбрано'); return; }
    if (ids.length > BULK_LIMIT) { showToast('error', `Максимум ${BULK_LIMIT} за раз`); return; }
    setConfirmBulk({ ids });
  };

  return (
    <div className={styles.page}>
      {/* Настройки токена */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <ShieldCheck size={18} />
          <h3>Подключение newdb.net</h3>
          <span className={settingsQuery.data?.hasToken ? styles.pillOk : styles.pillWarn}>
            {settingsQuery.data?.hasToken ? 'Токен задан' : 'Токен не задан'}
          </span>
        </div>
        <p className={styles.hint}>
          Проверка РКЛ и патентов через API newdb.net. Токен (X-API-KEY) хранится в зашифрованном виде.
          Базовый URL: <code>{settingsQuery.data?.baseUrl ?? '—'}</code>
        </p>
        <div className={styles.settingsRow}>
          <input
            type="password"
            className={styles.input}
            placeholder="Вставьте API-токен (X-API-KEY)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
          <button className={styles.btnPrimary} disabled={!token.trim() || saveToken.isPending} onClick={() => saveToken.mutate()}>
            Сохранить
          </button>
          <button className={styles.btnSecondary} disabled={validate.isPending} onClick={() => validate.mutate()}>
            Проверить настройки
          </button>
        </div>
      </section>

      {/* Выбор организации + проверки */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3>Сотрудники подрядчика</h3>
          <button
            className={styles.iconBtn}
            disabled={!orgId || passesQuery.isFetching}
            onClick={() => queryClient.invalidateQueries({ queryKey: ['newdb', 'passes', orgId] })}
            title="Обновить список"
          >
            <RefreshCw size={16} className={passesQuery.isFetching ? styles.spin : ''} />
          </button>
        </div>

        <div className={styles.selectWrap}>
          <select
            className={styles.select}
            value={orgId}
            onChange={(e) => { setOrgId(e.target.value); setSelected(new Set()); }}
          >
            <option value="">
              {orgsQuery.isLoading ? 'Загрузка организаций…' : 'Выберите подрядную организацию…'}
            </option>
            {orgs.map(o => (
              <option key={o.id} value={o.id}>{o.name} ({o.with_fio})</option>
            ))}
          </select>
        </div>

        {!orgId ? (
          <div className={styles.empty}>Выберите подрядную организацию, чтобы увидеть сотрудников.</div>
        ) : passesQuery.isLoading ? (
          <div className={styles.empty}><Loader2 size={18} className={styles.spin} /> Загрузка…</div>
        ) : passes.length === 0 ? (
          <div className={styles.empty}>В выбранной организации нет сотрудников с ФИО.</div>
        ) : (
          <>
            <div className={styles.bulkBar}>
              <button className={styles.btnSecondary} onClick={selectWithoutResult}>Выбрать без результата</button>
              <button
                className={styles.btnPrimary}
                disabled={selected.size === 0 || runBulk.isPending}
                onClick={startBulk}
              >
                {runBulk.isPending
                  ? <><Loader2 size={14} className={styles.spin} /> Проверка…</>
                  : `Проверить выбранных (${selected.size})`}
              </button>
              {selected.size > BULK_LIMIT && <span className={styles.limitWarn}>макс {BULK_LIMIT} за раз</span>}
            </div>

            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th className={styles.checkCol}>
                      <input
                        type="checkbox"
                        checked={selected.size > 0 && selected.size === passes.length}
                        ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < passes.length; }}
                        onChange={toggleAll}
                        aria-label="Выбрать всех"
                      />
                    </th>
                    <th>№</th>
                    <th>ФИО</th>
                    <th>Гражданство</th>
                    <th>Паспорт</th>
                    <th>РКЛ</th>
                    <th>Патент Мск</th>
                    <th>Патент МО</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {passes.map((p: CheckPassRow) => (
                    <tr key={p.id} className={selected.has(p.id) ? styles.rowSel : ''}>
                      <td className={styles.checkCol}>
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleRow(p.id)} aria-label={`Выбрать ${p.holder_name ?? p.pass_number}`} />
                      </td>
                      <td className={styles.mono}>{p.pass_number}</td>
                      <td>{p.holder_name ?? '—'}</td>
                      <td>{p.citizenship ?? '—'}</td>
                      <td className={styles.mono}>{p.passport_series_number ?? '—'}</td>
                      <td><StatusIcon kind="rkl" status={p.last_rkl_status} at={p.last_rkl_at} summary={p.last_rkl_summary} /></td>
                      <td><StatusIcon kind="patent_msk" status={p.last_patent_msk_status} at={p.last_patent_msk_at} summary={p.last_patent_msk_summary} /></td>
                      <td><span className={styles.badgeMuted} title="Требуется ИНН физлица (в системе не собирается)">—</span></td>
                      <td>
                        <div className={styles.rowActions}>
                          <button
                            className={styles.btnCheck}
                            disabled={runningRow === p.id || runBulk.isPending}
                            onClick={() => runOne.mutate(p.id)}
                          >
                            {runningRow === p.id ? <Loader2 size={14} className={styles.spin} /> : 'Проверить'}
                          </button>
                          <button className={styles.iconBtn} title="Сырой ответ" onClick={() => openLatestRaw(p.id)}>
                            <Eye size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {confirmBulk && (
        <ConfirmBulkModal
          count={confirmBulk.ids.length}
          pending={runBulk.isPending}
          onCancel={() => setConfirmBulk(null)}
          onConfirm={() => runBulk.mutate(confirmBulk.ids)}
        />
      )}
      {rawFor !== null && <RawModal data={rawFor} onClose={() => setRawFor(null)} />}
    </div>
  );
};

const ConfirmBulkModal: FC<{ count: number; pending: boolean; onCancel: () => void; onConfirm: () => void }> = ({ count, pending, onCancel, onConfirm }) => {
  const overlay = useOverlayDismiss(onCancel);
  return (
    <div className={styles.overlay} {...overlay}>
      <div className={styles.modalSm}>
        <div className={styles.modalHeader}><AlertTriangle size={16} /> <span>Подтверждение</span></div>
        <p className={styles.confirmText}>
          Будет проверено <b>{count}</b> сотрудников — до <b>{count * 2}</b> внешних запросов
          (РКЛ + Патент по каждому; часть может стать «не требуется» или отсеяться валидацией).
          Это платная операция. Продолжить?
        </p>
        <div className={styles.confirmActions}>
          <button className={styles.btnSecondary} disabled={pending} onClick={onCancel}>Отмена</button>
          <button className={styles.btnPrimary} disabled={pending} onClick={onConfirm}>
            {pending ? <><Loader2 size={14} className={styles.spin} /> Проверка…</> : 'Проверить'}
          </button>
        </div>
      </div>
    </div>
  );
};

const RawModal: FC<{ data: unknown; onClose: () => void }> = ({ data, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  return (
    <div className={styles.overlay} {...overlay}>
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <Eye size={16} /> <span>Сырой ответ newdb</span>
          <button className={styles.iconBtn} onClick={onClose}>✕</button>
        </div>
        <pre className={styles.raw}>{JSON.stringify(data, null, 2)}</pre>
      </div>
    </div>
  );
};
