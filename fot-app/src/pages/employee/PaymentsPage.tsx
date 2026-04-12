import { type FC } from 'react';
import { PAYMENT_TYPE_LABELS, type IPayment } from '../../services/paymentService';
import { useMyPayments } from '../../hooks/usePortalData';
import './PaymentsPage.css';

const formatMoney = (v: number) => v.toLocaleString('ru-RU', { minimumFractionDigits: 2 }) + ' р.';
const formatDate = (d: string) => new Date(d).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
const EMPTY_PAYMENTS: IPayment[] = [];

export const PaymentsPage: FC = () => {
  const { data, isLoading } = useMyPayments();
  const payments = data ?? EMPTY_PAYMENTS;

  return (
    <div className="pm-page">
      <h1 className="pm-title">История выплат</h1>

      {isLoading ? (
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
