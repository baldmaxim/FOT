import { useQuery, useQueryClient } from '@tanstack/react-query';
import { contractorAdminService, type IOtTrainingDef } from '../../../services/contractorService';

export { fmtDate, todayLocal, isValidIsoDate } from '../../ot/otShared';

/** Каталог видов обучения — статичен на время сессии, тянем один раз. */
export const useOtCatalog = (): IOtTrainingDef[] => {
  const q = useQuery({
    queryKey: ['ot-training-catalog', 'contractor'],
    queryFn: () => contractorAdminService.getOtCatalog(),
    staleTime: Infinity,
  });
  return q.data ?? [];
};

/** Инвалидация всех трёх списков реестра: счётчики организаций зависят от строк. */
export const useOtitbInvalidate = (): (() => Promise<void>) => {
  const qc = useQueryClient();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['contractor-induction'] }),
      qc.invalidateQueries({ queryKey: ['contractor-induction-orgs'] }),
      qc.invalidateQueries({ queryKey: ['contractor-induction-all'] }),
    ]);
  };
};
