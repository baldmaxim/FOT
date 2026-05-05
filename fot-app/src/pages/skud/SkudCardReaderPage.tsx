import type { FC } from 'react';
import { useNavigate } from 'react-router-dom';
import { CardReaderPanel } from '../../components/skud/CardReaderPanel';
import '../../components/skud/CardReaderPanel.css';

export const SkudCardReaderPage: FC = () => {
  const navigate = useNavigate();

  return (
    <div className="scr-page">
      <header className="scr-header">
        <h1 className="scr-title">Считыватель пропусков</h1>
      </header>
      <CardReaderPanel
        mode={{
          kind: 'lookup',
          onEmployeeFound: (employeeId) => navigate(`/employees/${employeeId}`),
        }}
      />
    </div>
  );
};

export default SkudCardReaderPage;
