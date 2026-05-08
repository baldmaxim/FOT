import { useCallback, useMemo, useState } from 'react';
import { ApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { invalidateAccessPointPreview } from './useAccessPointMapPreview';
import { travelTimeService } from '../services/travelTimeService';
import type { IAccessPointMapView } from '../types';
import { AccessPointMapModal } from '../components/skud/AccessPointMapModal';

export const useAccessPointMapViewer = (canOpen: boolean) => {
  const toast = useToast();
  const [mapData, setMapData] = useState<IAccessPointMapView | null>(null);

  const openAccessPointMap = useCallback(async (accessPointName: string) => {
    if (!canOpen || !accessPointName.trim()) return;

    try {
      const data = await travelTimeService.getAccessPointMap(accessPointName.trim());
      if (!data) {
        toast.info('Карта для точки доступа не настроена');
        return;
      }
      setMapData(data);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        toast.error('Нет доступа к карте точки доступа');
        return;
      }

      toast.info(error instanceof Error ? error.message : 'Карта для точки доступа не настроена');
    }
  }, [canOpen, toast]);

  const refreshMapData = useCallback(async () => {
    const currentName = mapData?.access_point_name?.trim();
    if (!currentName) return;
    invalidateAccessPointPreview(currentName);
    try {
      const fresh = await travelTimeService.getAccessPointMap(currentName);
      if (fresh) setMapData(fresh);
    } catch {
      // Тихо игнорируем — модалка останется с прежней data, alt-текст будет видно вместо картинки.
    }
  }, [mapData?.access_point_name]);

  const accessPointMapModal = useMemo(() => (
    <AccessPointMapModal
      open={!!mapData}
      data={mapData}
      onClose={() => setMapData(null)}
      onImageError={refreshMapData}
    />
  ), [mapData, refreshMapData]);

  return {
    canOpenAccessPointMap: canOpen,
    openAccessPointMap,
    accessPointMapModal,
  };
};
