import { type FC, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Download, AlertTriangle } from 'lucide-react';
import { patentReceiptService } from '../services/patentReceiptService';
import { ModalShell } from './ui/ModalShell';
import { triggerBlobDownload } from '../utils/download';
import { useToast } from '../contexts/ToastContext';
import styles from './MissingPatentReceiptsModal.module.css';

interface IProps {
  onClose: () => void;
}

/** 'YYYY-MM' предыдущего месяца относительно текущей даты. */
const prevMonthValue = (): string => {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
};

const monthToFrom = (ym: string): string => `${ym}-01`;

const monthToTo = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${ym}-${String(last).padStart(2, '0')}`;
};

const formatAmount = (value: number): string =>
  new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

export const MissingPatentReceiptsModal: FC<IProps> = ({ onClose }) => {
  const toast = useToast();
  const [fromMonth, setFromMonth] = useState(prevMonthValue);
  const [toMonth, setToMonth] = useState(prevMonthValue);
  const [exporting, setExporting] = useState(false);

  const valid = fromMonth !== '' && toMonth !== '' && fromMonth <= toMonth;
  const from = valid ? monthToFrom(fromMonth) : '';
  const to = valid ? monthToTo(toMonth) : '';

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['missing-patent', from, to],
    queryFn: () => patentReceiptService.listMissing(from, to),
    enabled: valid,
    // Глобально refetchOnMount: false — иначе список не увидит смену гражданства
    // в карточке сотрудника, пока не истечёт gcTime.
    refetchOnMount: 'always',
  });

  const rows = data?.data ?? [];
  const requiredSum = data?.required_sum ?? null;
  const monthsCount = data?.months_count ?? null;

  const requiredLabel = useMemo(() => {
    if (requiredSum == null || monthsCount == null) return null;
    return `${monthsCount} мес × 10 000 = ${formatAmount(requiredSum)} ₽`;
  }, [requiredSum, monthsCount]);

  const handleExport = async () => {
    if (!valid) return;
    setExporting(true);
    try {
      const blob = await patentReceiptService.exportMissing(from, to);
      triggerBlobDownload(blob, `Чеки_не_прикреплены_${from}_${to}.xlsx`);
    } catch {
      toast.error('Ошибка экспорта');
    } finally {
      setExporting(false);
    }
  };

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.modal}>
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <h3>
              <AlertTriangle size={18} /> Чеки за патент не прикреплены
            </h3>
            <button className={styles.closeBtn} onClick={requestClose} title="Закрыть">
              <X size={18} />
            </button>
          </div>

          <div className={styles.toolbar}>
            <label className={styles.field}>
              <span>С (месяц)</span>
              <input type="month" value={fromMonth} onChange={e => setFromMonth(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>По (месяц)</span>
              <input type="month" value={toMonth} onChange={e => setToMonth(e.target.value)} />
            </label>
            {requiredLabel && <span className={styles.requiredHint}>Требуется: {requiredLabel}</span>}
            <button
              className={styles.btnPrimary}
              onClick={handleExport}
              disabled={!valid || exporting || rows.length === 0}
            >
              <Download size={14} className={exporting ? styles.spin : undefined} /> Экспорт в Excel
            </button>
          </div>

          <div className={styles.body}>
            {!valid ? (
              <div className={styles.empty}>Период «по» не может быть раньше периода «с»</div>
            ) : isLoading || isFetching ? (
              <div className={styles.empty}>Загрузка…</div>
            ) : rows.length === 0 ? (
              <div className={styles.empty}>Все прикрепили чеки за выбранный период</div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th className={styles.colNum}>№</th>
                      <th>ФИО</th>
                      <th>Должность</th>
                      <th>Бригада/отдел</th>
                      <th>Объекты</th>
                      <th>Руководитель</th>
                      <th className={styles.alignRight}>Сумма ₽</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, idx) => (
                      <tr key={r.employee_id}>
                        <td className={styles.colNum}>{idx + 1}</td>
                        <td>{r.full_name || '—'}</td>
                        <td>{r.position_name || '—'}</td>
                        <td>{r.department_name || '—'}</td>
                        <td>{r.objects.length ? r.objects.join(', ') : '—'}</td>
                        <td>{r.manager_full_name || '—'}</td>
                        <td className={styles.alignRight}>{formatAmount(r.paid_sum)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className={styles.footer}>
            <span className={styles.count}>{valid && !isLoading ? `Всего: ${rows.length}` : ''}</span>
            <button className={styles.btnSecondary} onClick={requestClose}>Закрыть</button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
