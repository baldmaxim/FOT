import { type FC, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Zap } from 'lucide-react';
import { apiClient } from '../../api/client';
import { useStructureTree } from '../../hooks/useStructure';
import { getTreeFlatDepartments } from '../../utils/departmentUtils';
import styles from './PayslipManagePage.module.css';

interface IGeneratedPayslip {
  employee_id: number;
  full_name: string;
  salary: number;
  norm_days: number;
  worked_days: number;
  gross_amount: number;
  deductions: number;
  net_amount: number;
}

const formatMoney = (v: number): string =>
  v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MONTH_NAMES = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

export const PayslipManagePage: FC = () => {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [departmentId, setDepartmentId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<IGeneratedPayslip[] | null>(null);
  const [generated, setGenerated] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const structureQuery = useStructureTree();
  const departments = useMemo(
    () => getTreeFlatDepartments(structureQuery.data?.departments || []),
    [structureQuery.data?.departments],
  );

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiClient.post<{ success: boolean; data: { generated: number; payslips: IGeneratedPayslip[] } }>(
        '/payslips/generate',
        { year, month, department_id: departmentId || undefined },
      );
      setResult(res.data.payslips || []);
      setGenerated(res.data.generated || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации');
    } finally {
      setGenerating(false);
    }
  };

  const prevMonth = () => {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };

  const nextMonth = () => {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  const totalGross = result?.reduce((s, r) => s + r.gross_amount, 0) ?? 0;
  const totalNet = result?.reduce((s, r) => s + r.net_amount, 0) ?? 0;
  const totalDeductions = result?.reduce((s, r) => s + r.deductions, 0) ?? 0;

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h2 className={styles.title}>Расчётные листки</h2>
        <div className={styles.controls}>
          <div className={styles.monthNav}>
            <button className={styles.navBtn} onClick={prevMonth}>
              <ChevronLeft size={18} />
            </button>
            <span className={styles.monthLabel}>
              {MONTH_NAMES[month - 1]} {year}
            </span>
            <button className={styles.navBtn} onClick={nextMonth}>
              <ChevronRight size={18} />
            </button>
          </div>
          <select
            className={styles.deptSelect}
            value={departmentId}
            onChange={e => setDepartmentId(e.target.value)}
          >
            <option value="">Все отделы</option>
            {departments.map(d => (
              <option key={d.id} value={d.id} disabled={d.hasChildren}>
                {'\u00A0\u00A0'.repeat(d.level)}{d.name}
              </option>
            ))}
          </select>
          <button className={styles.generateBtn} onClick={handleGenerate} disabled={generating}>
            <Zap size={16} />
            {generating ? 'Генерация...' : 'Сгенерировать'}
          </button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {structureQuery.isError && (
        <div className={styles.error}>Не удалось загрузить структуру подразделений</div>
      )}

      {result && (
        <>
          <div className={styles.summary}>
            Сгенерировано: <strong>{generated}</strong> листков.
            Итого начислено: <strong>{formatMoney(totalGross)} ₽</strong>,
            НДФЛ: <strong>{formatMoney(totalDeductions)} ₽</strong>,
            к выплате: <strong>{formatMoney(totalNet)} ₽</strong>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Оклад</th>
                  <th>Норма дн.</th>
                  <th>Отработано дн.</th>
                  <th>Начислено</th>
                  <th>НДФЛ</th>
                  <th>К выплате</th>
                </tr>
              </thead>
              <tbody>
                {result.map(r => (
                  <tr key={r.employee_id}>
                    <td className={styles.nameCell}>{r.full_name}</td>
                    <td>{formatMoney(r.salary)}</td>
                    <td>{r.norm_days}</td>
                    <td>{r.worked_days}</td>
                    <td>{formatMoney(r.gross_amount)}</td>
                    <td>{formatMoney(r.deductions)}</td>
                    <td className={styles.netCell}>{formatMoney(r.net_amount)}</td>
                  </tr>
                ))}
                {result.length > 0 && (
                  <tr className={styles.totalRow}>
                    <td colSpan={4}>Итого</td>
                    <td>{formatMoney(totalGross)}</td>
                    <td>{formatMoney(totalDeductions)}</td>
                    <td className={styles.netCell}>{formatMoney(totalNet)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!result && !generating && (
        <div className={styles.empty}>
          Выберите месяц, отдел и нажмите «Сгенерировать» для создания расчётных листков из данных табеля.
        </div>
      )}
    </div>
  );
};
