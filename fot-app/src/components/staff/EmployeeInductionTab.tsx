import { memo, useCallback, useMemo, useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { SearchInput } from '../ui/SearchInput';
import { DateInput } from '../ui/DateInput';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import {
  employeeInductionService,
  type IInductionRow,
  type InductionStatusFilter,
} from '../../services/employeeInductionService';
import styles from './EmployeeInductionTab.module.css';

const PAGE_SIZE = 100;

/** YYYY-MM-DD → ДД.ММ.ГГГГ строкой: new Date('YYYY-MM-DD') даёт UTC-сдвиг на день назад. */
const fmtDate = (iso: string | null): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—';
};

/** Полная и календарно существующая дата (31.02 не пройдёт). */
const isValidIsoDate = (value: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
};

const STATUS_OPTIONS: Array<{ key: InductionStatusFilter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'missing', label: 'Без инструктажа' },
  { key: 'passed', label: 'Пройден' },
];

interface IRowProps {
  row: IInductionRow;
  index: number;
  canEdit: boolean;
  onSave: (employeeId: number, inductedOn: string | null) => Promise<void>;
}

const InductionRow: FC<IRowProps> = memo(({ row, index, canEdit, onSave }) => {
  const serverValue = row.inducted_on ?? '';
  const [draft, setDraft] = useState(serverValue);
  const [busy, setBusy] = useState(false);
  // Смена ключа ремоунтит DateInput: повторная передача того же value внутреннее
  // состояние компонента не сбрасывает, а откатить незавершённый ввод нужно.
  const [resetRevision, setResetRevision] = useState(0);
  const [syncedValue, setSyncedValue] = useState(serverValue);

  // Синхронизация черновика с сервером в рендере (тот же приём, что в DateInput):
  // useEffect тут дал бы каскадный ре-рендер. Во время сохранения не трогаем —
  // иначе оптимистичное значение перебьёт ввод пользователя.
  if (!busy && serverValue !== syncedValue) {
    setSyncedValue(serverValue);
    setDraft(serverValue);
  }

  const revert = () => {
    setDraft(serverValue);
    setResetRevision(r => r + 1);
  };

  const handleChange = (next: string) => {
    // DateInput отдаёт '' на любом неполном вводе (в т.ч. на первой стёртой цифре).
    // Это не очистка — очистить дату можно только крестиком.
    if (next === '') return;
    if (!isValidIsoDate(next)) return;
    if (next === serverValue) {
      setDraft(next);
      return;
    }
    setDraft(next);
    setBusy(true);
    void onSave(row.employee_id, next)
      .catch(() => revert())
      .finally(() => setBusy(false));
  };

  const handleClear = () => {
    if (!serverValue) {
      revert();
      return;
    }
    setBusy(true);
    void onSave(row.employee_id, null)
      .catch(() => revert())
      .finally(() => setBusy(false));
  };

  return (
    <tr>
      <td className={styles.num}>{index}</td>
      <td>{row.full_name || '—'}</td>
      <td className={styles.muted}>{row.department_name || '—'}</td>
      <td className={styles.muted}>{row.position_name || '—'}</td>
      <td className={styles.dateCell}>
        {canEdit ? (
          <div className={styles.dateBox}>
            <DateInput
              key={`${row.employee_id}:${resetRevision}`}
              value={draft}
              onChange={handleChange}
              onBlur={() => { if (!busy && draft !== serverValue) revert(); }}
              disabled={busy}
            />
            <button
              type="button"
              className={styles.clearBtn}
              onClick={handleClear}
              disabled={busy || !serverValue}
              title="Снять дату инструктажа"
              aria-label="Снять дату инструктажа"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <span className={styles.dateText}>{fmtDate(row.inducted_on)}</span>
        )}
      </td>
    </tr>
  );
});

InductionRow.displayName = 'InductionRow';

/**
 * Вкладка «Вводный инструктаж»: свои сотрудники (СУ-10 + Служба Механизации) и дата
 * прохождения. Есть дата — инструктаж пройден, нет даты — не пройден; галочек нет.
 * Дату правит служба ОТиТБ (право /staff-control/induction edit), остальные смотрят.
 */
export const EmployeeInductionTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const canEdit = isAdmin || canEditPage('/staff-control/induction');

  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [status, setStatus] = useState<InductionStatusFilter>('all');
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300).trim();

  const listParams = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      departmentId: departmentId || undefined,
      search: debouncedSearch || undefined,
      status,
    }),
    [page, departmentId, debouncedSearch, status],
  );

  const listQueryKey = ['employee-induction', listParams] as const;

  const listQuery = useQuery({
    queryKey: listQueryKey,
    queryFn: () => employeeInductionService.list(listParams),
    placeholderData: previous => previous,
  });

  const departmentsQuery = useQuery({
    queryKey: ['employee-induction-departments'],
    queryFn: () => employeeInductionService.departments(),
    staleTime: 30 * 60_000,
  });

  const saveMutation = useMutation({
    mutationFn: ({ employeeId, inductedOn }: { employeeId: number; inductedOn: string | null }) =>
      employeeInductionService.setDate(employeeId, inductedOn),
    onSuccess: (inductedOn, { employeeId }) => {
      queryClient.setQueryData<Awaited<ReturnType<typeof employeeInductionService.list>>>(
        listQueryKey,
        previous => (previous
          ? {
            ...previous,
            data: previous.data.map(r => (r.employee_id === employeeId ? { ...r, inducted_on: inductedOn } : r)),
          }
          : previous),
      );
      void queryClient.invalidateQueries({ queryKey: ['employee-induction'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить дату инструктажа');
    },
  });

  // Стабильная ссылка — иначе memo на строках таблицы бесполезен.
  const { mutateAsync } = saveMutation;
  const handleSave = useCallback(async (employeeId: number, inductedOn: string | null): Promise<void> => {
    await mutateAsync({ employeeId, inductedOn });
  }, [mutateAsync]);

  const rows = listQuery.data?.data ?? [];
  const meta = listQuery.data?.meta;
  const departments = departmentsQuery.data ?? [];
  const totalPages = meta?.totalPages ?? 0;

  const resetPage = <T,>(setter: (value: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.filters}>
        <SearchInput
          className={styles.search}
          value={search}
          onValueChange={resetPage(setSearch)}
          placeholder="Поиск по ФИО..."
        />

        <select
          className={styles.select}
          value={departmentId}
          onChange={e => resetPage(setDepartmentId)(e.target.value)}
          aria-label="Отдел"
        >
          <option value="">Все отделы</option>
          {departments.map(d => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>

        <div className={styles.seg} role="tablist">
          {STATUS_OPTIONS.map(opt => (
            <button
              key={opt.key}
              type="button"
              role="tab"
              aria-selected={status === opt.key}
              className={`${styles.segBtn} ${status === opt.key ? styles.segBtnActive : ''}`}
              onClick={() => resetPage(setStatus)(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {meta && (
          <span className={styles.counter}>
            Пройдено {meta.passed} из {meta.total}
          </span>
        )}
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.num}>№</th>
              <th>ФИО</th>
              <th>Отдел</th>
              <th>Должность</th>
              <th className={styles.dateCell}>Дата инструктажа</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <InductionRow
                key={row.employee_id}
                row={row}
                index={(page - 1) * PAGE_SIZE + i + 1}
                canEdit={canEdit}
                onSave={handleSave}
              />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className={styles.empty}>
                  {listQuery.isPending ? 'Загрузка…' : 'Сотрудники не найдены'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.pagerBtn}
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Назад
          </button>
          <span className={styles.pagerInfo}>Стр. {page} из {totalPages}</span>
          <button
            type="button"
            className={styles.pagerBtn}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Вперёд
          </button>
        </div>
      )}
    </div>
  );
};

export default EmployeeInductionTab;
