import { useMemo, useState, type FC } from 'react';
import {
  adminService,
  type BrigadeWorkerAnalysis,
  type BrigadeWorkerPreview,
  type BrigadeWorkerTransferInput,
} from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import styles from '../../pages/admin/Admin.module.css';

interface IBrigadeWorkerTransferPanelProps {
  brigadeName: string;
  targetDepartmentId: string;
  targetDepartmentName: string | null;
  analysis: BrigadeWorkerAnalysis;
  onTransferApplied: () => Promise<void> | void;
}

type TransferSelection = {
  [workerKey: string]: {
    selected: boolean;
    employee_id: number;
  };
};

const makeWorkerKey = (worker: BrigadeWorkerPreview, index: number): string => (
  `${index}::${worker.normalized_name}::${worker.employee_id ?? 'x'}`
);

export const BrigadeWorkerTransferPanel: FC<IBrigadeWorkerTransferPanelProps> = ({
  brigadeName,
  targetDepartmentId,
  targetDepartmentName,
  analysis,
  onTransferApplied,
}) => {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState<TransferSelection>({});
  const [ambiguousChoice, setAmbiguousChoice] = useState<Record<string, number>>({});
  const [applying, setApplying] = useState(false);

  const counts = useMemo(() => {
    const counters = {
      already: 0,
      transferable: 0,
      archived: 0,
      notFound: 0,
      ambiguous: 0,
    };
    for (const worker of analysis.excel_workers) {
      switch (worker.status) {
        case 'already_in_brigade': counters.already += 1; break;
        case 'in_other_department': counters.transferable += 1; break;
        case 'archived_match': counters.archived += 1; break;
        case 'not_found': counters.notFound += 1; break;
        case 'ambiguous': counters.ambiguous += 1; break;
      }
    }
    return counters;
  }, [analysis.excel_workers]);

  const selectedCount = useMemo(
    () => Object.values(selection).filter(entry => entry.selected).length,
    [selection],
  );

  const handleToggle = (workerKey: string, employeeId: number | undefined, nextSelected: boolean): void => {
    if (!employeeId) return;
    setSelection(prev => ({
      ...prev,
      [workerKey]: { selected: nextSelected, employee_id: employeeId },
    }));
  };

  const handleAmbiguousPick = (workerKey: string, candidateId: number): void => {
    setAmbiguousChoice(prev => ({ ...prev, [workerKey]: candidateId }));
    setSelection(prev => ({
      ...prev,
      [workerKey]: { selected: true, employee_id: candidateId },
    }));
  };

  const handleApply = async (): Promise<void> => {
    const transfers: BrigadeWorkerTransferInput[] = Object.values(selection)
      .filter(entry => entry.selected)
      .map(entry => ({
        employee_id: entry.employee_id,
        target_department_id: targetDepartmentId,
      }));

    if (transfers.length === 0) {
      toast.error('Не выбрано ни одного сотрудника для переноса');
      return;
    }

    setApplying(true);
    try {
      const result = await adminService.applyBrigadeWorkerTransfers({ transfers });
      const messages: string[] = [`Перенесено: ${result.applied}`];
      if (result.restored > 0) messages.push(`из архива: ${result.restored}`);
      if (result.skipped.length > 0) messages.push(`пропущено: ${result.skipped.length}`);
      if (result.errors.length > 0) messages.push(`ошибок: ${result.errors.length}`);
      toast.success(messages.join(', '));
      setSelection({});
      setAmbiguousChoice({});
      await onTransferApplied();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось выполнить переносы');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className={styles.workerPanel}>
      <div className={styles.workerPanelHeader}>
        <div>
          <span className={styles.workerPanelTitle}>Состав бригады по Excel</span>
          {targetDepartmentName && (
            <span className={styles.workerBadge}>→ {targetDepartmentName}</span>
          )}
        </div>
        <button
          type="button"
          className={styles.workerPanelToggle}
          onClick={() => setExpanded(prev => !prev)}
        >
          {expanded ? 'Свернуть' : 'Развернуть'}
        </button>
      </div>

      <div className={styles.workerPanelStats}>
        <span className={`${styles.workerPanelStat} ${styles.workerPanelStatOk}`}>
          В бригаде: {counts.already}
        </span>
        {counts.transferable > 0 && (
          <span className={`${styles.workerPanelStat} ${styles.workerPanelStatWarn}`}>
            В других отделах: {counts.transferable}
          </span>
        )}
        {counts.archived > 0 && (
          <span className={styles.workerPanelStat}>
            Архив: {counts.archived}
          </span>
        )}
        {counts.ambiguous > 0 && (
          <span className={`${styles.workerPanelStat} ${styles.workerPanelStatWarn}`}>
            Однофамильцы: {counts.ambiguous}
          </span>
        )}
        {counts.notFound > 0 && (
          <span className={`${styles.workerPanelStat} ${styles.workerPanelStatErr}`}>
            Не найдено: {counts.notFound}
          </span>
        )}
        {analysis.missing_from_excel.length > 0 && (
          <span className={styles.workerPanelStat}>
            Нет в Excel: {analysis.missing_from_excel.length}
          </span>
        )}
      </div>

      {expanded && (
        <>
          <div className={styles.workerList}>
            {analysis.excel_workers.map((worker, index) => {
              const workerKey = makeWorkerKey(worker, index);

              if (worker.status === 'already_in_brigade') {
                return (
                  <div key={workerKey} className={`${styles.workerItem} ${styles.workerItemOk}`}>
                    <input type="checkbox" className={styles.workerCheckbox} checked readOnly disabled />
                    <div className={styles.workerInfo}>
                      <span className={styles.workerName}>{worker.original_name}</span>
                      <span className={styles.workerMeta}>Уже в бригаде «{brigadeName}»</span>
                    </div>
                  </div>
                );
              }

              if (worker.status === 'not_found') {
                return (
                  <div key={workerKey} className={`${styles.workerItem} ${styles.workerItemErr}`}>
                    <input type="checkbox" className={styles.workerCheckbox} disabled />
                    <div className={styles.workerInfo}>
                      <span className={styles.workerName}>{worker.original_name}</span>
                      <span className={styles.workerMeta}>Нет в базе сотрудников</span>
                    </div>
                  </div>
                );
              }

              if (worker.status === 'ambiguous') {
                const chosen = ambiguousChoice[workerKey];
                return (
                  <div key={workerKey} className={`${styles.workerItem} ${styles.workerItemTransfer}`}>
                    <input
                      type="checkbox"
                      className={styles.workerCheckbox}
                      checked={Boolean(selection[workerKey]?.selected && chosen)}
                      disabled={!chosen}
                      onChange={(event) => handleToggle(workerKey, chosen, event.target.checked)}
                    />
                    <div className={styles.workerInfo}>
                      <span className={styles.workerName}>{worker.original_name}</span>
                      <span className={styles.workerMeta}>
                        Несколько совпадений — выберите нужного:
                      </span>
                      <div className={styles.workerCandidates}>
                        {(worker.candidates || []).map(candidate => (
                          <button
                            key={candidate.employee_id}
                            type="button"
                            className={`${styles.workerCandidateBtn} ${
                              chosen === candidate.employee_id ? styles.workerCandidateBtnActive : ''
                            }`}
                            onClick={() => handleAmbiguousPick(workerKey, candidate.employee_id)}
                          >
                            id {candidate.employee_id}
                            {candidate.department_name ? ` • ${candidate.department_name}` : ' • без отдела'}
                            {candidate.is_archived ? ' • архив' : ''}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              }

              const isArchived = worker.status === 'archived_match';
              const isSelected = Boolean(selection[workerKey]?.selected);
              const currentDeptName = worker.current_department_name || 'без отдела';
              return (
                <div
                  key={workerKey}
                  className={`${styles.workerItem} ${
                    isArchived ? styles.workerItemArchived : styles.workerItemTransfer
                  }`}
                >
                  <input
                    type="checkbox"
                    className={styles.workerCheckbox}
                    checked={isSelected}
                    onChange={(event) => handleToggle(workerKey, worker.employee_id, event.target.checked)}
                  />
                  <div className={styles.workerInfo}>
                    <span className={styles.workerName}>
                      {worker.original_name}
                      {isArchived && (
                        <span className={`${styles.workerBadge} ${styles.workerBadgeArchived}`}>
                          архив — будет возвращён
                        </span>
                      )}
                    </span>
                    <span className={styles.workerMeta}>
                      Сейчас: {currentDeptName} → {targetDepartmentName || brigadeName}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {analysis.missing_from_excel.length > 0 && (
            <div className={styles.workerMissingList}>
              <div style={{ fontWeight: 500, marginBottom: 4 }}>
                Сейчас в бригаде, но нет в Excel ({analysis.missing_from_excel.length}):
              </div>
              {analysis.missing_from_excel.map(entry => entry.full_name).join(', ')}
            </div>
          )}

          <div className={styles.workerPanelActions}>
            <button
              type="button"
              className={styles.workerPanelToggle}
              disabled={applying || selectedCount === 0}
              onClick={() => void handleApply()}
              style={{ fontWeight: 600 }}
            >
              {applying
                ? 'Переношу...'
                : selectedCount > 0
                  ? `Перенести выбранных (${selectedCount})`
                  : 'Перенести выбранных'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};
