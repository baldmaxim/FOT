import { type FC } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle } from 'lucide-react';
import { useAccessPointMapPreview } from '../../hooks/useAccessPointMapPreview';
import '../../styles/AccessPointMap.css';

interface IAccessPointTriggerProps {
  accessPointName: string;
  className: string;
  canOpen: boolean;
  onOpen: (accessPointName: string) => Promise<void> | void;
}

export const AccessPointTrigger: FC<IAccessPointTriggerProps> = ({
  accessPointName,
  className,
  canOpen,
  onOpen,
}) => {
  const {
    open,
    loading,
    preview,
    popoverStyle,
    wrapperRef,
    popoverRef,
    openPreview,
    scheduleClose,
  } = useAccessPointMapPreview<HTMLButtonElement>(accessPointName, canOpen);

  if (!canOpen) {
    return <span className={className}>{accessPointName}</span>;
  }

  return (
    <>
      <button
        ref={wrapperRef}
        type="button"
        className={`skud-map-point-button skud-map-point-button--interactive ${className}`}
        onClick={event => {
          event.stopPropagation();
          void onOpen(accessPointName);
        }}
        onMouseEnter={openPreview}
        onMouseLeave={scheduleClose}
        onFocus={openPreview}
        onBlur={scheduleClose}
        title="Открыть карту точки доступа"
      >
        {accessPointName}
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className="skud-map-preview-popover"
          role="tooltip"
          style={popoverStyle ?? { visibility: 'hidden' }}
          onMouseEnter={openPreview}
          onMouseLeave={scheduleClose}
        >
          {loading && !preview ? (
            <div className="skud-map-preview-loading">
              <LoaderCircle size={14} className="skud-map-preview-spin" />
              <span>Загрузка карты...</span>
            </div>
          ) : preview ? (
            <>
              <div className="skud-map-preview-title">{preview.object_name}</div>
              <div className="skud-map-preview-subtitle">{preview.access_point_name}</div>
              <div className="skud-map-preview-stage">
                <img
                  src={preview.image_url}
                  alt={`Карта объекта ${preview.object_name}`}
                  className="skud-map-preview-image"
                />
                <div
                  className="skud-map-preview-marker"
                  style={{ left: `${preview.x_ratio * 100}%`, top: `${preview.y_ratio * 100}%` }}
                />
              </div>
            </>
          ) : (
            <div className="skud-map-preview-empty">Миниатюра карты не настроена.</div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
};
