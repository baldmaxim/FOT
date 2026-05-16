import { useEffect, useMemo, useRef, useState, type CSSProperties, type FC } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Sun, Moon } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { employeeService } from '../../services/employeeService';
import { patentReceiptService, type IMyPatentReceipt, type RecognitionStatus } from '../../services/patentReceiptService';
import type { Employee } from '../../types/employee';
import { ApiError } from '../../api/client';
import { formatFioShort } from '../../utils/formatFio';
import { useTheme } from '../../hooks/useTheme';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  WorkerLocaleProvider,
  WORKER_LOCALES,
  useWorkerLocale,
  type WorkerLocale,
} from '../../i18n/workerCabinet';

const pageStyle: CSSProperties = {
  // dvh — корректная высота при мобильном адресбаре / mini-app webview
  minHeight: '100dvh',
  background: 'var(--bg-primary)',
  // страница рендерится вне EmployeeLayout — safe-area вручную
  padding:
    'max(24px, env(safe-area-inset-top, 0px)) calc(16px + env(safe-area-inset-right, 0px)) max(48px, env(safe-area-inset-bottom, 0px)) calc(16px + env(safe-area-inset-left, 0px))',
  display: 'flex',
  justifyContent: 'center',
};

const containerStyle: CSSProperties = {
  width: '100%',
  maxWidth: 720,
  display: 'grid',
  gap: 20,
};

const cardStyle: CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 20,
  padding: 20,
  display: 'grid',
  gap: 12,
};

const labelStyle: CSSProperties = { color: 'var(--text-secondary)', fontSize: 13 };
const valueStyle: CSSProperties = { fontSize: 18, fontWeight: 600 };

const primaryButton: CSSProperties = {
  padding: '14px 20px',
  borderRadius: 14,
  border: 'none',
  background: 'var(--accent)',
  color: '#fff',
  fontSize: 16,
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButton: CSSProperties = {
  padding: '12px 18px',
  borderRadius: 12,
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'var(--text-primary)',
  fontSize: 15,
  fontWeight: 600,
  cursor: 'pointer',
};

const logoutButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  width: '100%',
  padding: '14px 20px',
  borderRadius: 14,
  border: '1px solid #b23a48',
  background: 'transparent',
  color: '#b23a48',
  fontSize: 16,
  fontWeight: 600,
  cursor: 'pointer',
};

const langBarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 6,
  flexWrap: 'wrap',
};

const langButtonStyle = (active: boolean): CSSProperties => ({
  padding: '9px 14px',
  minHeight: 40,
  borderRadius: 999,
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
  background: active ? 'var(--accent)' : 'transparent',
  color: active ? '#fff' : 'var(--text-primary)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
});

interface IRecognitionBadge {
  label: string;
  color: string;
}

const recognitionBadge = (status: RecognitionStatus | null | undefined, t: (k: string) => string): IRecognitionBadge => {
  switch (status) {
    case 'pending':
      return { label: t('recognition.pending'), color: '#7a7a7a' };
    case 'processing':
      return { label: t('recognition.processing'), color: '#b78103' };
    case 'done':
      return { label: t('recognition.done'), color: '#1e7e34' };
    case 'needs_review':
      return { label: t('recognition.needsReview'), color: '#b78103' };
    case 'failed':
      return { label: t('recognition.failed'), color: '#b23a48' };
    default:
      return { label: '—', color: 'var(--text-secondary)' };
  }
};

const recognitionBadgeStyle = (color: string): CSSProperties => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  background: 'var(--bg-primary)',
  color,
  border: `1px solid ${color}33`,
});

const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('ru-RU');
};

const amountFormatter = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatAmount = (raw: string | null): string => {
  if (raw === null || raw === undefined || raw === '') return '—';
  const num = Number(raw);
  if (!Number.isFinite(num)) return String(raw);
  return `${amountFormatter.format(num)} ₽`;
};

const daysUntil = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diff = d.getTime() - Date.now();
  return Math.ceil(diff / (24 * 60 * 60_000));
};

const PATENT_WARN_DAYS = 30;

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  zIndex: 1000,
};

const overlayCardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 360,
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: 24,
  display: 'grid',
  gap: 14,
  textAlign: 'center',
};

const uploadModalCardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 420,
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: 16,
  padding: 24,
  display: 'grid',
  gap: 16,
};

const spinnerStyle: CSSProperties = {
  width: 44,
  height: 44,
  margin: '0 auto',
  border: '4px solid var(--border)',
  borderTopColor: 'var(--accent)',
  borderRadius: '50%',
  animation: 'workerUploadSpin 0.8s linear infinite',
};

interface IUploadStatusModalProps {
  status: { state: 'uploading' | 'uploaded' | 'error'; message?: string };
  onClose: () => void;
}

const UploadReceiptStatusModal: FC<IUploadStatusModalProps> = ({ status, onClose }) => {
  const { t } = useWorkerLocale();
  const isUploading = status.state === 'uploading';
  const title =
    status.state === 'uploading' ? t('status.uploading.title') :
    status.state === 'uploaded' ? t('status.uploaded.title') :
    t('status.error.title');
  const subtitle =
    status.state === 'uploading' ? t('status.uploading.subtitle') :
    status.state === 'uploaded' ? t('status.uploaded.subtitle') :
    (status.message || t('status.error.subtitleDefault'));
  const iconColor =
    status.state === 'uploaded' ? '#1e7e34' :
    status.state === 'error' ? '#b23a48' :
    'var(--accent)';

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-live="polite">
      <style>{`@keyframes workerUploadSpin { to { transform: rotate(360deg); } }`}</style>
      <div style={overlayCardStyle}>
        {status.state === 'uploading' ? (
          <div style={spinnerStyle} />
        ) : (
          <div
            style={{
              width: 56,
              height: 56,
              margin: '0 auto',
              borderRadius: '50%',
              background: `${iconColor}1f`,
              color: iconColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 30,
              fontWeight: 700,
            }}
          >
            {status.state === 'uploaded' ? '✓' : '!'}
          </div>
        )}
        <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{subtitle}</div>
        {!isUploading && (
          <button
            type="button"
            onClick={onClose}
            style={{
              marginTop: 4,
              padding: '12px 20px',
              borderRadius: 12,
              border: 'none',
              background: 'var(--accent)',
              color: '#fff',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            {t('status.close')}
          </button>
        )}
      </div>
    </div>
  );
};

interface IUploadFormModalProps {
  onClose: () => void;
  onSubmit: (file: File, periodStart: string, periodEnd: string) => void;
}

const UploadReceiptFormModal: FC<IUploadFormModalProps> = ({ onClose, onSubmit }) => {
  const { t } = useWorkerLocale();
  const isNarrow = useIsMobile(430);
  const [file, setFile] = useState<File | null>(null);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [touched, setTouched] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const periodInvalid = Boolean(periodStart && periodEnd && periodStart > periodEnd);
  const canSubmit = Boolean(file && periodStart && periodEnd && !periodInvalid);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.files?.[0] ?? null;
    setFile(next);
  };

  const handleSubmit = () => {
    setTouched(true);
    if (!canSubmit) return;
    onSubmit(file as File, periodStart, periodEnd);
  };

  const inputStyle: CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    // >=16px — иначе iOS Safari зумит при фокусе
    fontSize: 16,
    boxSizing: 'border-box',
  };

  const labelText: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 };

  return (
    <div style={{ ...overlayStyle, padding: isNarrow ? 12 : 20 }} role="dialog" aria-modal="true" onClick={onClose}>
      <div style={uploadModalCardStyle} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>{t('upload.modal.title')}</div>

        <fieldset
          style={{
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: '12px 14px 14px',
            margin: 0,
            display: 'grid',
            gap: 10,
          }}
        >
          <legend
            style={{
              padding: '0 6px',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-secondary)',
            }}
          >
            {t('upload.modal.periodHint')}
          </legend>
          <div style={{ display: 'grid', gap: isNarrow ? 12 : 16, gridTemplateColumns: isNarrow ? '1fr' : '1fr 1fr' }}>
            <label>
              <div style={labelText}>{t('upload.modal.periodFrom')}</div>
              <input
                type="date"
                value={periodStart}
                onChange={e => setPeriodStart(e.target.value)}
                style={inputStyle}
              />
            </label>
            <label>
              <div style={labelText}>{t('upload.modal.periodTo')}</div>
              <input
                type="date"
                value={periodEnd}
                onChange={e => setPeriodEnd(e.target.value)}
                style={inputStyle}
              />
            </label>
          </div>
        </fieldset>

        {periodInvalid && (
          <div style={{ color: '#b23a48', fontSize: 13 }}>{t('upload.modal.errorPeriodOrder')}</div>
        )}

        <div>
          <div style={labelText}>{t('upload.modal.fileLabel')}</div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{ ...secondaryButton, width: '100%' }}
          >
            {file ? t('upload.modal.changeFile') : t('upload.modal.selectFile')}
          </button>
          {file && (
            <div style={{ marginTop: 8, fontSize: 13, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
              {file.name}
            </div>
          )}
        </div>

        {touched && !canSubmit && !periodInvalid && (
          <div style={{ color: '#b23a48', fontSize: 13 }}>{t('upload.modal.errorMissing')}</div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" onClick={onClose} style={secondaryButton}>
            {t('upload.modal.cancel')}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{ ...primaryButton, opacity: canSubmit ? 1 : 0.5 }}
          >
            {t('upload.modal.submit')}
          </button>
        </div>
      </div>
    </div>
  );
};

const themeToggleStyle: CSSProperties = {
  width: 40,
  height: 40,
  padding: 0,
  borderRadius: 12,
  border: '1px solid var(--border)',
  background: 'var(--bg-primary)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginInlineStart: 4,
};

const ThemeToggleButton: FC = () => {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      style={themeToggleStyle}
      aria-label={isDark ? 'Светлая тема' : 'Тёмная тема'}
      title={isDark ? 'Светлая тема' : 'Тёмная тема'}
    >
      {isDark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
};

const LanguageSwitcher: FC = () => {
  const { locale, setLocale, t } = useWorkerLocale();
  return (
    <div style={langBarStyle} aria-label={t('language.label')}>
      {WORKER_LOCALES.map(({ code, label }) => (
        <button
          key={code}
          type="button"
          onClick={() => setLocale(code as WorkerLocale)}
          style={langButtonStyle(locale === code)}
        >
          {label}
        </button>
      ))}
      <ThemeToggleButton />
    </div>
  );
};

const ObjectWorkerDashboardContent: FC = () => {
  const { profile, logout, isAdmin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t } = useWorkerLocale();

  const isPreview = isAdmin && searchParams.get('preview') === 'worker';
  const employeeId = profile?.employee_id ?? null;

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [employeeLoading, setEmployeeLoading] = useState<boolean>(true);
  const [receipts, setReceipts] = useState<IMyPatentReceipt[]>([]);
  const [receiptsLoading, setReceiptsLoading] = useState<boolean>(true);
  const [uploadStatus, setUploadStatus] = useState<{ state: 'uploading' | 'uploaded' | 'error'; message?: string } | null>(null);
  const [uploadFormOpen, setUploadFormOpen] = useState(false);

  useEffect(() => {
    if (uploadStatus?.state !== 'uploaded') return;
    const timer = window.setTimeout(() => setUploadStatus(null), 2500);
    return () => window.clearTimeout(timer);
  }, [uploadStatus]);

  useEffect(() => {
    let cancelled = false;
    if (!employeeId) {
      setEmployeeLoading(false);
      return;
    }
    setEmployeeLoading(true);
    employeeService.getById(employeeId)
      .then(data => { if (!cancelled) setEmployee(data); })
      .catch(err => {
        console.error('employee load error:', err);
        if (!cancelled) toast.error(t('toast.error.employeeLoad'));
      })
      .finally(() => { if (!cancelled) setEmployeeLoading(false); });
    return () => { cancelled = true; };
  }, [employeeId, toast, t]);

  const reloadReceipts = () => {
    if (!employeeId) {
      setReceipts([]);
      setReceiptsLoading(false);
      return;
    }
    setReceiptsLoading(true);
    patentReceiptService.listMy()
      .then(data => setReceipts(data || []))
      .catch(err => {
        console.error('receipts load error:', err);
        toast.error(t('toast.error.receiptsLoad'));
      })
      .finally(() => setReceiptsLoading(false));
  };

  useEffect(() => {
    reloadReceipts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  const patentExpiryDate = employee?.patent_expiry_date ?? null;
  const patentDaysLeft = useMemo(() => daysUntil(patentExpiryDate), [patentExpiryDate]);
  const patentHighlight: CSSProperties = useMemo(() => {
    if (patentDaysLeft === null) return { color: 'var(--text-primary)' };
    if (patentDaysLeft <= 0) return { color: '#b23a48' };
    if (patentDaysLeft <= PATENT_WARN_DAYS) return { color: '#b78103' };
    return { color: 'var(--text-primary)' };
  }, [patentDaysLeft]);

  const patentHelper = useMemo(() => {
    if (!patentExpiryDate) return t('patent.helper.notSet');
    if (patentDaysLeft === null) return '';
    if (patentDaysLeft < 0) return t('patent.helper.expired', { n: Math.abs(patentDaysLeft) });
    if (patentDaysLeft === 0) return t('patent.helper.expiresToday');
    if (patentDaysLeft <= PATENT_WARN_DAYS) return t('patent.helper.expiresSoon', { n: patentDaysLeft });
    return t('patent.helper.daysLeft', { n: patentDaysLeft });
  }, [patentExpiryDate, patentDaysLeft, t]);

  const uploading = uploadStatus?.state === 'uploading';

  const handleOpenUploadForm = () => {
    if (!employeeId || uploading) return;
    setUploadFormOpen(true);
  };

  const handleSubmitUpload = async (file: File, periodStart: string, periodEnd: string) => {
    if (!employeeId) return;
    setUploadFormOpen(false);
    setUploadStatus({ state: 'uploading' });
    try {
      await patentReceiptService.uploadMy(file, periodStart, periodEnd);
      setUploadStatus({ state: 'uploaded' });
      reloadReceipts();
    } catch (err) {
      console.error('patent check upload error:', err);
      const detail = err instanceof ApiError ? err.message : null;
      setUploadStatus({ state: 'error', message: detail || t('toast.error.uploadFailed') });
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const fullName = employee?.full_name || profile?.full_name || '—';
  const hireDate = employee?.hire_date ?? null;
  const departmentName = employee?.department ?? null;
  const siteDisplay = useMemo(() => {
    const managerShort = formatFioShort(employee?.site_manager_full_name);
    if (managerShort) return `Уч. ${managerShort}`;
    if (employee?.site_name) return `Уч. ${employee.site_name}`;
    return null;
  }, [employee?.site_manager_full_name, employee?.site_name]);
  const disableActions = !employeeId;
  const noEmployeeBinding = !employeeId;

  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        <LanguageSwitcher />

        {isPreview && (
          <div style={{ ...cardStyle, borderColor: '#b78103', background: '#b781031a' }}>
            <div style={{ fontWeight: 600 }}>{t('preview.banner.title')}</div>
            <div style={labelStyle}>{t('preview.banner.hint')}</div>
          </div>
        )}

        {noEmployeeBinding && (
          <div style={{ ...cardStyle, borderColor: '#b23a48', background: '#b23a481a' }}>
            <div style={{ fontWeight: 600 }}>{t('notLinked.title')}</div>
            <div style={labelStyle}>{t('notLinked.hint')}</div>
          </div>
        )}

        <section style={cardStyle}>
          <div>
            <div style={labelStyle}>{t('profile.label.employee')}</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
              {employeeLoading && !employee ? t('profile.loading') : fullName}
            </div>
          </div>
          <div>
            <div style={labelStyle}>{t('profile.label.department')}</div>
            <div style={valueStyle}>{departmentName || '—'}</div>
          </div>
          <div>
            <div style={labelStyle}>{t('profile.label.site')}</div>
            <div style={valueStyle}>{siteDisplay || '—'}</div>
          </div>
          <div>
            <div style={labelStyle}>{t('profile.label.hireDate')}</div>
            <div style={valueStyle}>{formatDate(hireDate)}</div>
          </div>
        </section>

        <section style={cardStyle}>
          <div style={labelStyle}>{t('patent.label.expiry')}</div>
          <div style={{ fontSize: 28, fontWeight: 800, ...patentHighlight }}>
            {formatDate(patentExpiryDate)}
          </div>
          {patentHelper && (
            <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{patentHelper}</div>
          )}

          <button
            type="button"
            style={{ ...primaryButton, opacity: disableActions || uploading ? 0.6 : 1 }}
            onClick={handleOpenUploadForm}
            disabled={disableActions || uploading}
          >
            {uploading ? t('patent.button.uploading') : t('patent.button.upload')}
          </button>
        </section>

        <section style={cardStyle}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{t('receipts.title')}</div>

          <div style={{ display: 'grid', gap: 8 }}>
            {receiptsLoading && <div style={labelStyle}>{t('receipts.loading')}</div>}
            {!receiptsLoading && receipts.length === 0 && (
              <div style={labelStyle}>{t('receipts.empty')}</div>
            )}
            {!receiptsLoading && receipts.map(receipt => {
              const badge = recognitionBadge(receipt.documents?.recognition_status ?? null, t);
              const dateLabel = receipt.payment_date
                ? t('receipts.label.paymentDate', { value: formatDate(receipt.payment_date) })
                : t('receipts.label.uploaded', { value: formatDate(receipt.created_at) });
              const periodLabel = receipt.period_start && receipt.period_end
                ? t('receipts.label.period', { from: formatDate(receipt.period_start), to: formatDate(receipt.period_end) })
                : null;
              return (
                <div key={receipt.id} style={{ ...cardStyle, padding: 14, gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 600 }}>{formatAmount(receipt.payment_amount)}</div>
                    <span style={recognitionBadgeStyle(badge.color)}>{badge.label}</span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{dateLabel}</div>
                  {periodLabel && (
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{periodLabel}</div>
                  )}
                  {receipt.documents?.file_name && (
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                      {receipt.documents.file_name}
                    </div>
                  )}
                  {receipt.download_url && (
                    <a
                      href={receipt.download_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent)' }}
                    >
                      {t('receipts.openOriginal')}
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section style={cardStyle}>
          <button
            type="button"
            style={logoutButtonStyle}
            onClick={handleLogout}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#b23a4811'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {t('logout')}
          </button>
        </section>
      </div>
      {uploadFormOpen && (
        <UploadReceiptFormModal
          onClose={() => setUploadFormOpen(false)}
          onSubmit={handleSubmitUpload}
        />
      )}
      {uploadStatus && (
        <UploadReceiptStatusModal
          status={uploadStatus}
          onClose={() => setUploadStatus(null)}
        />
      )}
    </div>
  );
};

export const ObjectWorkerDashboardPage: FC = () => (
  <WorkerLocaleProvider>
    <ObjectWorkerDashboardContent />
  </WorkerLocaleProvider>
);
