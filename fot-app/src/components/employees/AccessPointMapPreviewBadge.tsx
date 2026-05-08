import { type FC, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, MapPinned } from 'lucide-react';
import { useAccessPointMapPreview } from '../../hooks/useAccessPointMapPreview';

interface IAccessPointMapPreviewBadgeProps {
  accessPointName: string;
  enabled: boolean;
}

export const AccessPointMapPreviewBadge: FC<IAccessPointMapPreviewBadgeProps> = ({
  accessPointName,
  enabled,
}) => {
  const normalizedName = accessPointName.trim();
  const {
    open,
    loading,
    preview,
    popoverStyle,
    wrapperRef,
    popoverRef,
    openPreview,
    scheduleClose,
    reloadPreview,
  } = useAccessPointMapPreview<HTMLDivElement>(normalizedName, enabled);
  const failedUrlsRef = useRef<Set<string>>(new Set());

  if (!enabled || !normalizedName) {
    return null;
  }

  return (
    <div
      ref={wrapperRef}
      className="ep-sigur-map-badge-wrap"
      onMouseEnter={openPreview}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className="ep-sigur-map-badge"
        aria-label={`Показать мини-карту точки доступа ${normalizedName}`}
        aria-expanded={open}
        onFocus={openPreview}
        onBlur={scheduleClose}
      >
        <MapPinned size={12} />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={popoverRef}
          className="ep-sigur-map-popover"
          role="tooltip"
          style={popoverStyle ?? { visibility: 'hidden' }}
          onMouseEnter={openPreview}
          onMouseLeave={scheduleClose}
        >
          {loading && !preview ? (
            <div className="ep-sigur-map-loading">
              <LoaderCircle size={14} className="ep-sigur-spin" />
              <span>Загрузка карты...</span>
            </div>
          ) : preview ? (
            <>
              <div className="ep-sigur-map-title">{preview.object_name}</div>
              <div className="ep-sigur-map-subtitle">{preview.access_point_name}</div>
              <div className="ep-sigur-map-stage">
                <img
                  src={preview.image_url}
                  alt={`Карта объекта ${preview.object_name}`}
                  className="ep-sigur-map-image"
                  onError={() => {
                    if (failedUrlsRef.current.has(preview.image_url)) return;
                    failedUrlsRef.current.add(preview.image_url);
                    reloadPreview();
                  }}
                />
                <div
                  className="ep-sigur-map-marker"
                  style={{ left: `${preview.x_ratio * 100}%`, top: `${preview.y_ratio * 100}%` }}
                />
              </div>
            </>
          ) : (
            <div className="ep-sigur-map-empty">Миниатюра карты не настроена.</div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
};
