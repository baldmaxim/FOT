import { type FC, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Check } from 'lucide-react';
import { timesheetReviewService } from '../../services/timesheetReviewService';
import { useToast } from '../../contexts/ToastContext';

interface IProps {
  departmentId: string | null;
  startDate: string;
  endDate: string;
  /** Только табельщица видит кнопку-переключатель; остальные — read-only статус. */
  canToggle: boolean;
}

const reviewKey = (departmentId: string | null, startDate: string, endDate: string) =>
  ['timesheet-review', departmentId, startDate, endDate] as const;

/**
 * Отметка «Проверено» табельщицей по табелю бригады за период.
 * Табельщица переключает статус кнопкой (серый → зелёный); другие роли
 * видят зелёный статус «Проверено», когда отметка стоит.
 */
export const TimesheetReviewControl: FC<IProps> = ({ departmentId, startDate, endDate, canToggle }) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);

  const statusQuery = useQuery({
    queryKey: reviewKey(departmentId, startDate, endDate),
    queryFn: () => timesheetReviewService.getStatus(departmentId as string, startDate, endDate),
    enabled: !!departmentId && !!startDate && !!endDate,
    staleTime: 30_000,
  });

  const checked = statusQuery.data?.checked ?? false;
  const checkedByName = statusQuery.data?.checked_by_name ?? null;

  const handleToggle = async () => {
    if (!departmentId || saving) return;
    setSaving(true);
    try {
      const next = await timesheetReviewService.setStatus(departmentId, startDate, endDate, !checked);
      queryClient.setQueryData(reviewKey(departmentId, startDate, endDate), next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось изменить отметку «Проверено»');
    } finally {
      setSaving(false);
    }
  };

  if (!departmentId) return null;

  if (!canToggle) {
    if (!checked) return null;
    return (
      <span
        className="ts-review-badge ts-review-badge--checked"
        title={checkedByName ? `Проверено: ${checkedByName}` : 'Табель проверен табельщицей'}
      >
        <CheckCircle2 size={14} /> Проверено
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`ts-btn ts-review-toggle${checked ? ' ts-review-toggle--checked' : ''}`}
      onClick={handleToggle}
      disabled={saving}
      title={checked
        ? `Снять отметку${checkedByName ? ` (поставил: ${checkedByName})` : ''}`
        : 'Отметить табель как проверенный'}
    >
      {checked ? <CheckCircle2 size={16} /> : <Check size={16} />} Проверено
    </button>
  );
};
