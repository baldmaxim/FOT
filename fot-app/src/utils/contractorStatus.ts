import type {
  ContractorPassStatus,
  ContractorPassApprovalStatus,
} from '../services/contractorService';

const passStatusLabels: Record<ContractorPassStatus, string> = {
  in_pool: 'В пуле',
  assigned: 'Назначен подрядчику',
  submitted: 'На согласовании',
  applied: 'Активен',
  blocked: 'Заблокирован',
  revoked: 'Аннулирован',
};

const approvalStatusLabels: Record<ContractorPassApprovalStatus, string> = {
  not_submitted: 'Не подан',
  pending: 'Ожидает',
  approved: 'Согласован',
  rejected: 'Отклонён',
};

export const passStatusLabel = (s: ContractorPassStatus): string =>
  passStatusLabels[s] ?? s;

export const approvalStatusLabel = (s: ContractorPassApprovalStatus): string =>
  approvalStatusLabels[s] ?? s;
