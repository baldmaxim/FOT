import { useMemo, useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, RefreshCw, Loader2, Eye } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { useStructureTree } from '../../hooks/useStructure';
import { DepartmentTreeSelect } from '../../components/staff/DepartmentTreeSelect';
import {
  checksService,
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
};

const StatusBadge: FC<{ status: CheckStatus | null; at: string | null; summary: string | null }> = ({ status, at, summary }) => {
  if (!status) return <span className={styles.badgeMuted}>—</span>;
  const cls = styles[`badge_${status}`] ?? styles.badgeMuted;
  const date = at ? new Date(at).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '';
  return (
    <span className={`${styles.badge} ${cls}`} title={summary ?? ''}>
      {STATUS_LABEL[status]}{date ? <span className={styles.badgeDate}> · {date}</span> : null}
    </span>
  );
};

export const ChecksPage: FC = () => {
  const { showToast } = useToast();
  const queryClient = useQueryClient();

  const [token, setToken] = useState('');
  const [deptId, setDeptId] = useState('');
  const [rawFor, setRawFor] = useState<{ checkId: string; data: unknown } | null>(null);
  const [runningRow, setRunningRow] = useState<string | null>(null);

  const structure = useStructureTree();

  const settingsQuery = useQuery({
    queryKey: ['newdb', 'settings'],
    queryFn: () => checksService.getConnectionSettings(),
    staleTime: 30_000,
  });

  const passesQuery = useQuery({
    queryKey: ['newdb', 'passes', deptId],
    queryFn: () => checksService.listPasses(deptId),
    enabled: !!deptId,
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

  const runCheck = useMutation({
    mutationFn: (passId: string) => checksService.run(passId, ['rkl', 'patent'] as CheckType[]),
    onMutate: (passId) => setRunningRow(passId),
    onSuccess: (results) => {
      const summary = results.map(r => `${r.check_type === 'rkl' ? 'РКЛ' : 'Патент'}: ${STATUS_LABEL[r.status]}`).join(' · ');
      showToast('success', summary);
      queryClient.invalidateQueries({ queryKey: ['newdb', 'passes', deptId] });
    },
    onError: (e: Error) => showToast('error', e.message || 'Ошибка проверки'),
    onSettled: () => setRunningRow(null),
  });

  // Открыть сырой ответ последней ОТПРАВЛЕННОЙ проверки по пропуску.
  const openLatestRaw = async (passId: string) => {
    try {
      const results = await checksService.getResults(passId);
      const latest = results.find(r => r.request_sent);
      if (!latest) {
        showToast('info', 'Нет отправленных проверок с ответом');
        return;
      }
      const data = await checksService.getRaw(latest.id);
      setRawFor({ checkId: latest.id, data });
    } catch (e) {
      showToast('error', e instanceof Error ? e.message : 'Ошибка');
    }
  };

  const departments = useMemo(() => structure.data?.departments ?? [], [structure.data]);
  const passes = passesQuery.data ?? [];

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

      {/* Выбор отдела + проверки */}
      <section className={styles.card}>
        <div className={styles.cardHeader}>
          <h3>Сотрудники подрядчика</h3>
          <button
            className={styles.iconBtn}
            disabled={!deptId || passesQuery.isFetching}
            onClick={() => queryClient.invalidateQueries({ queryKey: ['newdb', 'passes', deptId] })}
            title="Обновить список"
          >
            <RefreshCw size={16} className={passesQuery.isFetching ? styles.spin : ''} />
          </button>
        </div>

        <div className={styles.selectWrap}>
          <DepartmentTreeSelect
            departments={departments}
            value={deptId}
            onChange={setDeptId}
            isLoading={structure.isLoading}
            isError={structure.isError}
            onRetry={() => structure.refetch()}
            showAllOption={false}
            placeholder="Выберите отдел / подрядчика…"
          />
        </div>

        {!deptId ? (
          <div className={styles.empty}>Выберите отдел, чтобы увидеть сотрудников.</div>
        ) : passesQuery.isLoading ? (
          <div className={styles.empty}><Loader2 size={18} className={styles.spin} /> Загрузка…</div>
        ) : passes.length === 0 ? (
          <div className={styles.empty}>В выбранном отделе нет сотрудников с ФИО.</div>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>№</th>
                  <th>ФИО</th>
                  <th>Гражданство</th>
                  <th>Паспорт</th>
                  <th>РКЛ</th>
                  <th>Патент</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {passes.map((p: CheckPassRow) => (
                  <tr key={p.id}>
                    <td className={styles.mono}>{p.pass_number}</td>
                    <td>{p.holder_name ?? '—'}</td>
                    <td>{p.citizenship ?? '—'}</td>
                    <td className={styles.mono}>{p.passport_series_number ?? '—'}</td>
                    <td><StatusBadge status={p.last_rkl_status} at={p.last_rkl_at} summary={p.last_rkl_summary} /></td>
                    <td><StatusBadge status={p.last_patent_status} at={p.last_patent_at} summary={p.last_patent_summary} /></td>
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          className={styles.btnCheck}
                          disabled={runningRow === p.id}
                          onClick={() => runCheck.mutate(p.id)}
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
        )}
      </section>

      {rawFor && <RawModal data={rawFor.data} onClose={() => setRawFor(null)} />}
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
