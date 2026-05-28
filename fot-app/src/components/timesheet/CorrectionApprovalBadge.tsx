import { type FC } from 'react';
import { CheckCircle2 } from 'lucide-react';

interface IProps {
  approvedAt?: string | null;
  approverName?: string | null;
  approvalComment?: string | null;
}

const formatDateRu = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()} ${hh}:${mi}`;
};

export const CorrectionApprovalBadge: FC<IProps> = ({ approvedAt, approverName, approvalComment }) => {
  if (!approvedAt) return null;
  const dateText = formatDateRu(approvedAt);
  const tooltip = [
    `Согласовано: ${dateText}`,
    approverName ? `Кем: ${approverName}` : null,
    approvalComment ? `Комментарий: ${approvalComment}` : null,
  ].filter(Boolean).join('\n');
  return (
    <span className="ts-approval-badge" title={tooltip} aria-label="Корректировка согласована">
      <CheckCircle2 size={12} />
      Согласовано
    </span>
  );
};
