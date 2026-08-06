import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  contractorAdminService,
  type IContractorOrg,
  type IContractorPassAccessPointStats,
  type IContractorPassDetail,
  type IContractorPassStat,
} from '../../services/contractorService';
import { ContractorOrgSelect } from './ContractorOrgSelect';
import styles from '../../pages/contractor/Contractor.module.css';

interface IPassStatsModalProps {
  orgs: IContractorOrg[];
  orgsLoading: boolean;
  onClose: () => void;
}

const EMPTY_TOTAL = { issued_new: 0, active_new: 0, old_total: 0, old_used: 0 };

/** Суффикс периода для имени файла экспорта (зеркален бэкенду statsPeriodFileSuffix). */
const periodFileSuffix = (dateFrom: string, dateTo: string): string => {
  if (dateFrom && dateTo) return `_${dateFrom}_${dateTo}`;
  if (dateFrom) return `_с_${dateFrom}`;
  if (dateTo) return `_по_${dateTo}`;
  return '';
};

/** YYYY-MM-DD → ДД.ММ.ГГГГ. */
const formatIsoDate = (iso: string): string => iso.split('-').reverse().join('.');

/**
 * Модалка статистики пропусков по подрядчику. По умолчанию — «Все подрядчики»
 * (строка на каждого подрядчика с данными), либо один выбранный.
 * Колонки: выдано новых / активные / всего старых / используются старые (2 нед.).
 * При выбранном подрядчике внизу — список выданных пропусков (текущие одобренные
 * держатели). Период фильтрует «выдано новых» и список по дате одобрения заявки.
 */
export const PassStatsModal: FC<IPassStatsModalProps> = ({ orgs, orgsLoading, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  const toast = useToast();
  const [orgId, setOrgId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState(false);

  const statsQuery = useQuery<IContractorPassStat[]>({
    queryKey: ['contractor-pass-stats', dateFrom, dateTo],
    queryFn: () => contractorAdminService.getPassStats(dateFrom || undefined, dateTo || undefined),
    staleTime: 30_000,
  });

  const detailsQuery = useQuery<IContractorPassDetail[]>({
    queryKey: ['contractor-pass-details', orgId, dateFrom, dateTo],
    queryFn: () =>
      contractorAdminService.getPassStatsDetails(orgId, dateFrom || undefined, dateTo || undefined),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  // Один подрядчик — только его строка; «все» — только непустые.
  const rows = useMemo(() => {
    const list = statsQuery.data ?? [];
    if (orgId) return list.filter(s => s.org_department_id === orgId);
    return list
      .filter(s => s.issued_new > 0 || s.active_new > 0 || s.old_total > 0)
      .slice()
      .sort((a, b) => a.org_name.localeCompare(b.org_name, 'ru'));
  }, [statsQuery.data, orgId]);

  const total = useMemo(
    () => rows.reduce(
      (acc, r) => ({
        issued_new: acc.issued_new + r.issued_new,
        active_new: acc.active_new + r.active_new,
        old_total: acc.old_total + r.old_total,
        old_used: acc.old_used + r.old_used,
      }),
      EMPTY_TOTAL,
    ),
    [rows],
  );

  // Разбивка активных пропусков по точкам доступа — состояние «на сейчас», период не влияет.
  const accessPointsQuery = useQuery<IContractorPassAccessPointStats>({
    queryKey: ['contractor-pass-access-points', orgId],
    queryFn: () => contractorAdminService.getPassAccessPointStats(orgId),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  const details = detailsQuery.data ?? [];
  const accessPoints = accessPointsQuery.data;
  const hasPeriod = Boolean(dateFrom || dateTo);

  const handleExport = async (): Promise<void> => {
    setExporting(true);
    try {
      const blob = await contractorAdminService.exportPassStats(
        orgId || undefined,
        dateFrom || undefined,
        dateTo || undefined,
      );
      const selected = orgs.find(o => o.id === orgId);
      const safe = (selected?.name ?? 'Все подрядчики').replace(/[\\/:*?"<>|]+/g, '_').trim();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Статистика_пропусков_${safe}${periodFileSuffix(dateFrom, dateTo)}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сформировать файл');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      className={styles.overlay}
      onMouseDown={overlay.onMouseDown}
      onMouseUp={overlay.onMouseUp}
      onMouseLeave={overlay.onMouseLeave}
      onTouchStart={overlay.onTouchStart}
      onTouchEnd={overlay.onTouchEnd}
    >
      <div className={`${styles.modal} ${styles.statsModal}`}>
        <h2 className={styles.modalTitle}>Статистика пропусков</h2>

        <div className={styles.filterRow}>
          <div className={styles.field}>
            <span className={styles.label}>Подрядчик</span>
            <ContractorOrgSelect
              orgs={orgs}
              value={orgId}
              onChange={setOrgId}
              emptyOptionLabel="Все подрядчики"
              loading={orgsLoading}
            />
          </div>
          <div className={`${styles.field} ${styles.dateField}`}>
            <span className={styles.label}>С даты</span>
            <input
              type="date"
              className={styles.input}
              value={dateFrom}
              max={dateTo || undefined}
              onChange={e => setDateFrom(e.target.value)}
            />
          </div>
          <div className={`${styles.field} ${styles.dateField}`}>
            <span className={styles.label}>По дату</span>
            <input
              type="date"
              className={styles.input}
              value={dateTo}
              min={dateFrom || undefined}
              onChange={e => setDateTo(e.target.value)}
            />
          </div>
          {hasPeriod && (
            <div className={`${styles.field} ${styles.filterAction}`}>
              <span className={styles.label}>&nbsp;</span>
              <button
                type="button"
                className={styles.btn}
                onClick={() => { setDateFrom(''); setDateTo(''); }}
              >
                Сбросить
              </button>
            </div>
          )}
          <div className={`${styles.field} ${styles.filterAction}`}>
            <span className={styles.label}>&nbsp;</span>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnIcon}`}
              onClick={() => void handleExport()}
              disabled={exporting || rows.length === 0}
            >
              <Download size={14} /> Export Excel
            </button>
          </div>
        </div>

        <div className={styles.statusNote} style={{ marginBottom: 10 }}>
          Старые «белые» пропуска — сотрудники в папке подрядчика без нового номерного пропуска.
          «Используются старые» — были проходы по СКУД за последние 2 недели.
          {hasPeriod
            ? ' При выбранном периоде «Выдано новых» — пропуска, одобренные (выданные сотрудникам) в периоде;'
              + ' «Активные» и «старые» — состояние на сейчас.'
            : ' Без периода «Выдано новых» — все неотозванные номерные пропуска (включая пустые слоты),'
              + ' а список ниже — только пропуска с одобренным держателем.'}
        </div>

        <div className={styles.statsBody}>
          {statsQuery.isLoading && <div className={styles.empty}>Загрузка…</div>}
          {statsQuery.isError && <div className={styles.empty}>Не удалось загрузить статистику</div>}
          {!statsQuery.isLoading && !statsQuery.isError && rows.length === 0 && (
            <div className={styles.empty}>Нет данных</div>
          )}
          {!statsQuery.isLoading && rows.length > 0 && (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Подрядчик</th>
                  <th>Выдано новых</th>
                  <th>Активные</th>
                  <th>Всего старых</th>
                  <th>Используются старые</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.org_department_id}>
                    <td>{r.org_name}</td>
                    <td>{r.issued_new}</td>
                    <td>{r.active_new}</td>
                    <td>{r.old_total}</td>
                    <td>{r.old_used}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 1 && (
                <tfoot>
                  <tr className={styles.statsTotalRow}>
                    <td>Итого</td>
                    <td>{total.issued_new}</td>
                    <td>{total.active_new}</td>
                    <td>{total.old_total}</td>
                    <td>{total.old_used}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}

          {orgId && (
            <>
              <div className={styles.statsSubtitle}>
                Точки доступа — активные пропуска
                {accessPointsQuery.isSuccess ? ` (${accessPoints?.active_total ?? 0})` : ''}
              </div>
              {accessPointsQuery.isLoading && <div className={styles.empty}>Загрузка…</div>}
              {accessPointsQuery.isError && (
                <div className={styles.empty}>Не удалось загрузить точки доступа</div>
              )}
              {accessPointsQuery.isSuccess && (accessPoints?.points.length ?? 0) === 0 && (
                <div className={styles.empty}>Нет активных пропусков</div>
              )}
              {accessPointsQuery.isSuccess && (accessPoints?.points.length ?? 0) > 0 && (
                <>
                  <div className={styles.apChips}>
                    {accessPoints?.points.map(p => (
                      <span
                        key={p.access_point_name ?? '__none__'}
                        className={`${styles.apChip} ${p.access_point_name ? '' : styles.apChipEmpty}`}
                      >
                        {p.access_point_name ?? 'Без точек'} <b>{p.passes_count}</b>
                      </span>
                    ))}
                  </div>
                  <div className={styles.statusNote}>
                    У пропуска может быть несколько точек — сумма по точкам больше числа
                    активных пропусков.
                  </div>
                </>
              )}

              <div className={styles.statsSubtitle}>
                Выданные пропуска{detailsQuery.isSuccess ? ` (${details.length})` : ''}
              </div>
              {detailsQuery.isLoading && <div className={styles.empty}>Загрузка…</div>}
              {detailsQuery.isError && <div className={styles.empty}>Не удалось загрузить список</div>}
              {detailsQuery.isSuccess && details.length === 0 && (
                <div className={styles.empty}>
                  {hasPeriod ? 'Нет выданных пропусков за период' : 'Нет выданных пропусков'}
                </div>
              )}
              {detailsQuery.isSuccess && details.length > 0 && (
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>ФИО</th>
                      <th>№ пропуска ФОТ</th>
                      <th>№ Sigur (W26)</th>
                      <th>Дата выдачи</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.map(d => (
                      <tr key={d.pass_id}>
                        <td>{d.holder_name}</td>
                        <td>{d.pass_number}</td>
                        <td>{d.w26 ?? '—'}</td>
                        <td>{formatIsoDate(d.issued_on)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>

        <div className={styles.modalActions}>
          <button className="btn-secondary" onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
};

export default PassStatsModal;
