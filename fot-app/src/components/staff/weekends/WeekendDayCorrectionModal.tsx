import { type FC, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';

import { useAuth } from '../../../contexts/AuthContext';
import { useCanViewSkudDirectory } from '../../../hooks/useCanViewSkudDirectory';
import { formatDateRu } from '../../../utils/calendarUtils';
import {
  getCorrectionDefaultHoursForDay,
  getFullDayThresholdHoursForDay,
  getScheduleForTimesheetDay,
  isPreHolidayForSchedule,
  isScheduleDayOff,
} from '../../../utils/scheduleUtils';
import type { IWeekendDayCorrection } from './useWeekendDayCorrection';
import styles from './WeekendsTab.module.css';

const TimesheetCorrectionModal = lazy(() => import('../../timesheet/TimesheetCorrectionModal').then(module => ({
  default: module.TimesheetCorrectionModal,
})));

const LOCK_MESSAGE = {
  approved: 'Период согласован — редактирование закрыто',
  submitted: 'Период подан — редактирование закрыто',
} as const;

interface IWeekendDayCorrectionModalProps {
  correction: IWeekendDayCorrection;
  /** Подсказка к закрытому дню: где его открыть. */
  lockHint?: string;
}

/** То же окно дня, что в «Табеле», с теми же значениями. Данные и обработчики — useWeekendDayCorrection. */
export const WeekendDayCorrectionModal: FC<IWeekendDayCorrectionModalProps> = ({ correction, lockHint }) => {
  const { canManageAsHrAdmin, canViewPage, showActualHours } = useAuth();
  const canViewSkudDirectory = useCanViewSkudDirectory();
  const {
    year, month, schedules, dailySchedules, calendar, canEdit, objectEntriesDisabled, lockStatusFor,
    modalOpen, modalEmployee, modalDay, modalEntry, modalMode, modalObjectEntry, modalObjectTarget, modalWorkDate,
    modalRefreshStatus, modalLiveSource, modalObjects, modalDefaultHours, modalMaxHours,
    objectPrompt, setObjectPrompt, closeModal, startModalDataRefresh, confirmObjectPrompt,
    handleSaveCorrection, handleSaveModalCorrection, handleAddRemoteOverWork, handleDeleteDayCorrection,
    handleDeleteObjectCorrection, handleUpdateReason, handleSaveObjectByTarget, handleDeleteObjectByTarget,
  } = correction;

  const viewOnly = modalEmployee?.view_only === true;
  const lockStatus = modalEmployee ? lockStatusFor(modalEmployee.id, modalWorkDate) : undefined;
  const locked = Boolean(lockStatus);
  const schedule = modalEmployee
    ? getScheduleForTimesheetDay(schedules, dailySchedules, modalEmployee.id, year, month, modalDay)
    : null;
  const plannedHours = schedule ? getCorrectionDefaultHoursForDay(schedule, calendar, year, month, modalDay) : null;

  const deleteHandler = (() => {
    if (viewOnly) return undefined;
    if (modalMode === 'object' && modalObjectEntry?.adjustment_id) return handleDeleteObjectCorrection;
    return modalEntry?.is_correction && modalEntry?.id != null && !modalEntry?.has_object_adjustments
      ? handleDeleteDayCorrection
      : undefined;
  })();

  const correctionInfo = (() => {
    if (modalMode === 'object' && modalObjectEntry?.adjustment_id) {
      return {
        is_correction: true,
        corrected_at: modalObjectEntry.corrected_at ?? modalEntry?.corrected_at ?? null,
        corrected_by_name: modalObjectEntry.corrected_by_name ?? modalEntry?.corrected_by_name ?? null,
        approved_at: modalEntry?.approved_at ?? null,
        approved_by_name: modalEntry?.approved_by_name ?? null,
        adjustment_id: modalObjectEntry.adjustment_id,
      };
    }
    return modalEntry?.is_correction
      ? {
          is_correction: true,
          corrected_at: modalEntry.corrected_at,
          corrected_by_name: modalEntry.corrected_by_name,
          approval_status: modalEntry.approval_status ?? null,
          approved_at: modalEntry.approved_at,
          approved_by_name: modalEntry.approved_by_name,
          adjustment_id: modalEntry.id,
        }
      : null;
  })();

  return (
    <>
      {modalOpen && (
        <Suspense fallback={null}>
          <TimesheetCorrectionModal
            open={modalOpen}
            onClose={closeModal}
            onSave={handleSaveModalCorrection}
            hideCorrectionTab={!canEdit && !viewOnly}
            allowAttachmentsOnCreate
            showDayFiles={canManageAsHrAdmin('/timesheet-hr')}
            viewOnly={viewOnly}
            onDelete={deleteHandler}
            infoBanner={lockStatus ? `${LOCK_MESSAGE[lockStatus]}${lockHint ? `. ${lockHint}` : ''}` : null}
            readOnly={viewOnly || locked}
            canEditReasonText={canEdit && !viewOnly}
            onUpdateReason={handleUpdateReason}
            allowedStatuses={
              // После выхода на работу добавочная правка — только «Корректировка табеля»; существующую можно менять.
              modalMode !== 'object' && modalEntry?.status === 'work' && !modalEntry?.is_correction
                ? ['manual']
                : undefined
            }
            initialStatus={
              modalMode === 'object' && modalObjectEntry?.adjustment_id
                ? 'manual'
                : (modalEntry?.status || 'work')
            }
            initialHours={modalDefaultHours}
            initialNotes={modalMode === 'object' ? (modalObjectEntry?.notes ?? '') : (modalEntry?.notes ?? '')}
            dayLabel={formatDateRu(modalDay, month)}
            title={modalMode === 'object' ? modalObjectTarget?.object_name : undefined}
            subtitle={modalMode === 'object' ? `${modalEmployee?.full_name || ''} • ${formatDateRu(modalDay, month)}` : undefined}
            employeeName={modalMode === 'object' ? undefined : modalEmployee?.full_name}
            employeeId={modalEmployee?.id}
            workDate={modalWorkDate}
            showTravelTab={(modalEntry?.travel_problematic_segments || 0) > 0 || (modalEntry?.travel_delay_minutes || 0) > 0}
            allowAccessPointMap={canViewSkudDirectory}
            hideSkudTab={!canViewPage('/timesheet/events')}
            deleteLabel={modalMode === 'object' ? 'Снять корректировку' : undefined}
            timesheetEntry={modalEntry}
            maxHours={modalMaxHours}
            correctionInfo={correctionInfo}
            preselectedObjectKey={modalMode === 'object' ? modalObjectTarget?.object_key ?? null : null}
            dayStatusContext={schedule ? {
              isScheduledDayOff: isScheduleDayOff(schedule, calendar, year, month, modalDay),
              isPreHoliday: isPreHolidayForSchedule(schedule, calendar, year, month, modalDay),
              fullDayThresholdHours: getFullDayThresholdHoursForDay(schedule, calendar, year, month, modalDay),
              showActualHours,
            } : undefined}
            objectChoice={modalObjects}
            // Прячем «эхо» дневной корректировки на объекте: она показывается отдельно.
            objectEntries={modalLiveSource ? modalLiveSource.objects.filter(entry => !entry.from_day_level) : undefined}
            disableObjectEntries={objectEntriesDisabled}
            plannedHours={plannedHours}
            hasDayLevelCorrection={Boolean(
              modalEntry?.is_correction && modalEntry?.id != null && !modalEntry?.has_object_adjustments,
            )}
            onSaveObject={handleSaveObjectByTarget}
            onDeleteObject={handleDeleteObjectByTarget}
            onZeroOutDay={(notes) => { void handleSaveCorrection('manual', 0, notes).then(() => closeModal()); }}
            companionWorkRequest={modalEntry?.companion_work_request ?? null}
            canAddRemote={
              modalMode !== 'object'
              && modalEntry?.status === 'work'
              && modalEntry?.source_type === 'leave_request'
              && !locked
            }
            remoteDefaultHours={plannedHours || 8}
            onAddRemote={handleAddRemoteOverWork}
            dataRefreshState={modalRefreshStatus === 'idle' ? null : (modalRefreshStatus === 'error' ? 'error' : 'loading')}
            onRetryDataRefresh={startModalDataRefresh}
          />
        </Suspense>
      )}

      {/* Объект не определился автоматически (OBJECT_REQUIRED). */}
      {objectPrompt && createPortal(
        <div className={styles.promptOverlay}>
          <div className={styles.prompt} role="dialog" aria-modal="true">
            <h3 className={styles.promptTitle}>Выберите объект</h3>
            <p className={styles.promptText}>
              Объект для этого дня не определён автоматически. Укажите, к какому объекту отнести часы.
            </p>
            {objectPrompt.candidates.length === 0 ? (
              <p className={styles.promptError}>У сотрудника нет доступных объектов.</p>
            ) : (
              <select
                className={styles.promptSelect}
                value={objectPrompt.selected}
                onChange={(event) => setObjectPrompt(prev => (prev ? { ...prev, selected: event.target.value } : prev))}
              >
                {objectPrompt.candidates.map(candidate => (
                  <option key={candidate.object_id} value={candidate.object_id}>{candidate.object_name}</option>
                ))}
              </select>
            )}
            <div className={styles.promptActions}>
              <button type="button" className="btn-secondary" onClick={() => setObjectPrompt(null)}>Отмена</button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => { void confirmObjectPrompt(); }}
                disabled={!objectPrompt.selected}
              >
                Сохранить
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
