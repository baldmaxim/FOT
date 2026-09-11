import { useMemo, useState, type FC } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  payrollService,
  PAYROLL_TERMS_PAGE_SIZE,
  STAFF_CATEGORY_LABELS,
  CALC_TYPE_LABELS,
  defaultCalcTypeFor,
  type IPayrollTermsRow,
  type PayrollCalcType,
  type StaffCategory,
} from '../../services/payrollService';
import { useToast } from '../../contexts/ToastContext';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { AssignTermsModal } from '../../components/salary/AssignTermsModal';
import styles from './CompensationTermsPage.module.css';

const today = () => new Date().toISOString().slice(0, 10);

const formatMoney = (value: string | number | null): string => {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '—';
  return num.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Сумма зависит от вида оплаты: у оклада — месячная, у почасовой — ставка за час. */
const formatAmount = (row: IPayrollTermsRow): string => {
  if (!row.terms_id) return '—';
  return row.calc_type === 'salary'
    ? `${formatMoney(row.monthly_salary)} ₽/мес`
    : `${formatMoney(row.hourly_rate)} ₽/час`;
};

const pluralEmployees = (count: number): string => {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return 'сотрудник';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'сотрудника';
  return 'сотрудников';
};

export const CompensationTermsPage: FC = () => {
  const { success, error: showError, warning } = useToast();
  const queryClient = useQueryClient();

  const [date, setDate] = useState(today);
  const [category, setCategory] = useState<StaffCategory | ''>('');
  const [calcType, setCalcType] = useState<PayrollCalcType | ''>('');
  const [onlyWithout, setOnlyWithout] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [modalFor, setModalFor] = useState<IPayrollTermsRow[] | null>(null);

  // Поиск идёт на сервере по всему штату: раньше он фильтровал только загруженные строки
  // и не находил никого за пределами первых 2000 по алфавиту.
  const debouncedSearch = useDebouncedValue(search.trim(), 300);

  // Любой фильтр меняет выборку: возвращаемся на первую страницу и снимаем выделение,
  // иначе можно назначить условия строкам, которых на экране уже нет.
  const resetPaging = () => {
    setPage(1);
    setSelected(new Set());
  };

  const termsQuery = useQuery({
    queryKey: ['payroll-terms', date, category, calcType, onlyWithout, debouncedSearch, page],
    queryFn: () => payrollService.listTerms({
      date,
      staffCategory: category || undefined,
      calcType: calcType || undefined,
      withoutTerms: onlyWithout || undefined,
      q: debouncedSearch || undefined,
      page,
      pageSize: PAYROLL_TERMS_PAGE_SIZE,
    }),
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const rows = useMemo(() => termsQuery.data?.rows ?? [], [termsQuery.data]);
  const meta = termsQuery.data?.meta;
  const total = meta?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAYROLL_TERMS_PAGE_SIZE));

  const assignMutation = useMutation({
    mutationFn: async (payload: Parameters<typeof payrollService.assignBulk>[1] & { ids: number[] }) => {
      const { ids, ...rest } = payload;
      return ids.length === 1
        ? payrollService.assign(ids[0], rest).then(() => ({ applied: [{ employee_id: ids[0], terms_id: 0 }], skipped: [] }))
        : payrollService.assignBulk(ids, rest);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['payroll-terms'] });
      setSelected(new Set());
      setModalFor(null);
      if (result.skipped.length > 0) {
        warning(`Применено: ${result.applied.length}. Отклонено: ${result.skipped.length} — ${result.skipped[0].message}`);
      } else {
        success(`Условия оплаты назначены: ${result.applied.length}`);
      }
    },
    onError: (err: Error) => showError(err.message || 'Не удалось назначить условия'),
  });

  const toggleOne = (employeeId: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });
  };

  const allVisibleSelected = rows.length > 0 && rows.every(row => selected.has(row.employee_id));
  const toggleAll = () => {
    setSelected(allVisibleSelected ? new Set() : new Set(rows.map(row => row.employee_id)));
  };

  const goToPage = (next: number) => {
    setPage(next);
    // Выделение действует в пределах страницы: на другой странице — другие люди.
    setSelected(new Set());
  };

  const openBulk = () => {
    const chosen = rows.filter(row => selected.has(row.employee_id));
    if (chosen.length > 0) setModalFor(chosen);
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>На дату</span>
          <input
            type="date"
            className={styles.input}
            value={date}
            onChange={event => { setDate(event.target.value); resetPaging(); }}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Категория</span>
          <select
            className={styles.input}
            value={category}
            onChange={event => { setCategory(event.target.value as StaffCategory | ''); resetPaging(); }}
          >
            <option value="">Все</option>
            {(Object.keys(STAFF_CATEGORY_LABELS) as StaffCategory[]).map(key => (
              <option key={key} value={key}>{STAFF_CATEGORY_LABELS[key]}</option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Вид оплаты</span>
          <select
            className={styles.input}
            value={calcType}
            onChange={event => { setCalcType(event.target.value as PayrollCalcType | ''); resetPaging(); }}
          >
            <option value="">Любой</option>
            {(Object.keys(CALC_TYPE_LABELS) as PayrollCalcType[]).map(key => (
              <option key={key} value={key}>{CALC_TYPE_LABELS[key]}</option>
            ))}
          </select>
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Поиск</span>
          <input
            type="search"
            className={styles.input}
            placeholder="ФИО или табельный"
            value={search}
            onChange={event => { setSearch(event.target.value); resetPaging(); }}
          />
        </label>

        <label className={styles.checkboxField}>
          <input
            type="checkbox"
            checked={onlyWithout}
            onChange={event => { setOnlyWithout(event.target.checked); resetPaging(); }}
          />
          <span>Только без условий</span>
        </label>
      </div>

      {meta && !meta.contractors_excluded && (
        <div className={styles.warning}>
          Не найден узел «Подрядные организации» — в списке могут оказаться сотрудники подрядчиков.
        </div>
      )}

      {meta && meta.without_terms_total > 0 && !onlyWithout && (
        <div className={styles.warning}>
          Без условий оплаты: <strong>{meta.without_terms_total}</strong>. Такие сотрудники
          в расчёт зарплаты не попадут.
        </div>
      )}

      <div className={styles.actions}>
        <span className={styles.counter}>
          {total} {pluralEmployees(total)}{selected.size > 0 ? `, выделено ${selected.size}` : ''}
        </span>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={selected.size === 0}
          onClick={openBulk}
        >
          Назначить выделенным
        </button>
      </div>

      {termsQuery.isLoading && <div className={styles.state}>Загрузка…</div>}
      {termsQuery.isError && <div className={styles.stateError}>Не удалось загрузить условия оплаты</div>}

      {!termsQuery.isLoading && !termsQuery.isError && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.checkboxCell}>
                  <input
                    type="checkbox"
                    aria-label="Выделить всех на странице"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                  />
                </th>
                <th>Сотрудник</th>
                <th>Таб. №</th>
                <th>Подразделение</th>
                <th>Категория</th>
                <th>Вид оплаты</th>
                <th>Сумма</th>
                <th>Действует с</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.employee_id} className={row.terms_id ? undefined : styles.rowMissing}>
                  <td className={styles.checkboxCell}>
                    <input
                      type="checkbox"
                      aria-label={`Выделить ${row.full_name ?? ''}`}
                      checked={selected.has(row.employee_id)}
                      onChange={() => toggleOne(row.employee_id)}
                    />
                  </td>
                  <td>{row.full_name ?? '—'}</td>
                  <td>{row.tab_number ?? '—'}</td>
                  <td>{row.department_name ?? '—'}</td>
                  <td>{row.staff_category ? STAFF_CATEGORY_LABELS[row.staff_category] : '—'}</td>
                  <td>{row.calc_type ? CALC_TYPE_LABELS[row.calc_type] : <span className={styles.missing}>не задан</span>}</td>
                  <td>{formatAmount(row)}</td>
                  <td>{row.effective_from ?? '—'}</td>
                  <td>
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setModalFor([row])}
                    >
                      {row.terms_id ? 'Изменить' : 'Назначить'}
                    </button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className={styles.state}>Сотрудники не найдены</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 && (
        <nav className={styles.pagination} aria-label="Страницы списка">
          <button
            type="button"
            className={styles.pageButton}
            disabled={page <= 1 || termsQuery.isFetching}
            onClick={() => goToPage(page - 1)}
          >
            ← Назад
          </button>
          <span className={styles.pageInfo}>
            Стр. {page} из {pageCount}
          </span>
          <button
            type="button"
            className={styles.pageButton}
            disabled={page >= pageCount || termsQuery.isFetching}
            onClick={() => goToPage(page + 1)}
          >
            Вперёд →
          </button>
        </nav>
      )}

      {modalFor && (
        <AssignTermsModal
          rows={modalFor}
          defaultDate={date}
          isSaving={assignMutation.isPending}
          onClose={() => setModalFor(null)}
          onSubmit={(payload) => assignMutation.mutate({
            ...payload,
            ids: modalFor.map(row => row.employee_id),
          })}
          resolveDefaultCalcType={defaultCalcTypeFor}
        />
      )}
    </div>
  );
};
