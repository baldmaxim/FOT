import { type FC, useState, useEffect, useCallback } from 'react';
import { FileText } from 'lucide-react';
import { payslipService, type IPayslip } from '../../services/payslipService';
import './PayslipsPage.css';

const formatMoney = (v: number | null) => v != null ? v.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' р.' : '—';

const formatPeriod = (period: string) => {
  const [y, m] = period.split('-');
  const months = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
};

export const PayslipsPage: FC = () => {
  const [payslips, setPayslips] = useState<IPayslip[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await payslipService.getMy();
      setPayslips(data);
    } catch {
      setPayslips([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="ps-page">
      <h1 className="ps-title">Расчётные листки</h1>

      {loading ? (
        <div className="ps-loading">Загрузка...</div>
      ) : payslips.length === 0 ? (
        <div className="ps-empty">Нет расчётных листков</div>
      ) : (
        <div className="ps-list">
          {payslips.map(p => (
            <div key={p.id} className="ps-card">
              <div className="ps-card-icon"><FileText size={20} /></div>
              <div className="ps-card-info">
                <div className="ps-card-period">{formatPeriod(p.period)}</div>
                <div className="ps-card-amounts">
                  <span className="ps-amount">Начислено: {formatMoney(p.gross_amount)}</span>
                  <span className="ps-amount ps-amount--net">К выплате: {formatMoney(p.net_amount)}</span>
                  <span className="ps-amount ps-amount--ded">Удержания: {formatMoney(p.deductions)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
