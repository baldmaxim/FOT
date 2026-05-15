import { useState, type FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CardReaderPanel } from '../../components/skud/CardReaderPanel';
import { SigurLiveEmployeeSidebar } from '../../components/skud/employees/SigurLiveEmployeeSidebar';
import { sigurAdminService } from '../../services/sigurAdminService';
import { useAuth } from '../../contexts/AuthContext';
import { SIGUR_ADMIN_QUERY_KEY } from '../../api/queryKeys';
import '../../components/skud/CardReaderPanel.css';

export const SkudCardReaderPage: FC = () => {
  const navigate = useNavigate();
  const { canEditPage } = useAuth();
  const canEdit = canEditPage('/skud-settings');

  const [selectedSigurEmployeeId, setSelectedSigurEmployeeId] = useState<number | null>(null);

  const departmentsQuery = useQuery({
    queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'departments-tree'],
    queryFn: () => sigurAdminService.getDepartmentsTree(),
    enabled: selectedSigurEmployeeId !== null,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
  });

  const positionsQuery = useQuery({
    queryKey: [...SIGUR_ADMIN_QUERY_KEY, 'positions'],
    queryFn: () => sigurAdminService.getPositions(),
    enabled: selectedSigurEmployeeId !== null && canEdit,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
  });

  const departments = departmentsQuery.data || [];
  const positions = positionsQuery.data || [];

  return (
    <div className="scr-page">
      <header className="scr-header">
        <h1 className="scr-title">Считыватель пропусков</h1>
      </header>
      <CardReaderPanel
        mode={{
          kind: 'lookup',
          onEmployeeFound: (employeeId) => navigate(`/employees/${employeeId}`),
          onSigurEmployeeFound: (sigurEmployeeId) => setSelectedSigurEmployeeId(sigurEmployeeId),
        }}
      />
      {selectedSigurEmployeeId !== null && (
        <SigurLiveEmployeeSidebar
          sigurEmployeeId={selectedSigurEmployeeId}
          employee={null}
          canEdit={canEdit}
          departments={departments}
          positions={positions}
          positionsLoading={positionsQuery.isLoading}
          onClose={() => setSelectedSigurEmployeeId(null)}
          onDirectoryChanged={async () => { await departmentsQuery.refetch(); }}
          onPositionsChanged={async () => { await positionsQuery.refetch(); }}
          onDeleted={(sigurEmployeeId) => {
            if (selectedSigurEmployeeId === sigurEmployeeId) setSelectedSigurEmployeeId(null);
          }}
        />
      )}
    </div>
  );
};

export default SkudCardReaderPage;
