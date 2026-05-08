import { type FC, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { IAccessPointMapView } from '../../types';
import '../../styles/AccessPointMap.css';

interface IAccessPointMapModalProps {
  open: boolean;
  data: IAccessPointMapView | null;
  onClose: () => void;
  onImageError?: () => void;
}

export const AccessPointMapModal: FC<IAccessPointMapModalProps> = ({ open, data, onClose, onImageError }) => {
  const failedUrlsRef = useRef<Set<string>>(new Set());
  if (!open || !data || typeof document === 'undefined') return null;

  return createPortal(
    <div className="skud-map-modal-overlay" onClick={onClose}>
      <div className="skud-map-modal" onClick={event => event.stopPropagation()}>
        <div className="skud-map-modal-header">
          <div>
            <h3 className="skud-map-modal-title">{data.object_name}</h3>
            <div className="skud-map-modal-subtitle">
              Точка доступа: {data.access_point_name}
            </div>
          </div>
          <button type="button" className="skud-map-modal-close" onClick={onClose} aria-label="Закрыть карту">
            ×
          </button>
        </div>

        <div className="skud-map-modal-stage">
          <div className="skud-map-modal-image-wrap">
            <img
              src={data.image_url}
              alt={`Карта объекта ${data.object_name}`}
              className="skud-map-modal-image"
              onError={() => {
                if (!onImageError) return;
                if (failedUrlsRef.current.has(data.image_url)) return;
                failedUrlsRef.current.add(data.image_url);
                onImageError();
              }}
            />
            <div
              className="skud-map-marker skud-map-marker--active"
              style={{ left: `${data.x_ratio * 100}%`, top: `${data.y_ratio * 100}%` }}
            >
              <div className="skud-map-marker-label">{data.access_point_name}</div>
            </div>
          </div>
        </div>

        <div className="skud-map-modal-hint">
          Маркер показывает конкретную точку прохода, к которой привязано выбранное событие СКУД.
        </div>
      </div>
    </div>,
    document.body,
  );
};
