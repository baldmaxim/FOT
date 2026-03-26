import { type FC, useState, useEffect, useCallback } from 'react';
import { paymentService, PAYMENT_TYPE_LABELS, type IPayment } from '../../services/paymentService';
import './PaymentsPage.css';

const formatMoney = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' р.';
const formatDate = (d: string) => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

export const PaymentsPage: FC = () => {
  const [payments, setPayments] = useState<IPayment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await paymentService.getMy();
      setPayments(data);
    } catch {
      setPayments([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="pm-page">
      <h1 className="pm-title">История выплат</h1>

      {loading ? (
        <div className="pm-loading">Загрузка...</div>
      ) : payments.length === 0 ? (
        <div className="pm-empty">Нет выплат</div>
      ) : (
        <div className="pm-list">
          {payments.map(p => (
            <div key={p.id} className="pm-card">
              <div className="pm-card-left">
                <div className="pm-card-type">{PAYMENT_TYPE_LABELS[p.payment_type]}</div>
                <div className="pm-card-date">{formatDate(p.payment_date)}</div>
                {p.description && <div className="pm-card-desc">{p.description}</div>}
              </div>
              <div className="pm-card-amount">{formatMoney(p.amount)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
