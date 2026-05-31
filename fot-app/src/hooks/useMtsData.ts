import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { mtsService } from '../services/mtsService';
import type { IGeoPoint } from '../services/mtsService';

export const getMtsConnectionQueryKey = () => ['mts', 'connection'] as const;
export const getMtsSubscribersQueryKey = () => ['mts', 'subscribers'] as const;
export const getMtsLocationsQueryKey = () => ['mts', 'last-locations'] as const;
export const getMtsMappingsQueryKey = () => ['mts', 'mappings'] as const;
export const getMtsSuggestionsQueryKey = () => ['mts', 'suggestions'] as const;

export const useMtsConnectionSettings = () => useQuery({
  queryKey: getMtsConnectionQueryKey(),
  queryFn: () => mtsService.getConnectionSettings(),
  staleTime: 5 * 60_000,
});

export const useMtsSubscribers = (enabled: boolean) => useQuery({
  queryKey: getMtsSubscribersQueryKey(),
  queryFn: () => mtsService.getSubscribers(),
  staleTime: 30_000,
  enabled,
});

/** Дополнительный запрос для диагностики (meta: upstreamTotal/hasFullAccess/filteredOut). */
export const useMtsSubscribersMeta = (enabled: boolean) => useQuery({
  queryKey: ['mts', 'subscribers', 'meta'] as const,
  queryFn: () => mtsService.getSubscribersWithMeta(),
  staleTime: 30_000,
  enabled,
});

export const useMtsLastLocations = (enabled: boolean) => useQuery({
  queryKey: getMtsLocationsQueryKey(),
  queryFn: () => mtsService.getLastLocations(),
  staleTime: 30_000,
  enabled,
});

export const useMtsMappings = (enabled: boolean) => useQuery({
  queryKey: getMtsMappingsQueryKey(),
  queryFn: () => mtsService.getMappings(),
  staleTime: 60_000,
  enabled,
});

export const useMtsSuggestions = (enabled: boolean) => useQuery({
  queryKey: getMtsSuggestionsQueryKey(),
  queryFn: () => mtsService.getMappingSuggestions(),
  staleTime: 60_000,
  enabled,
});

export const getMtsTasksQueryKey = () => ['mts', 'tasks'] as const;

export const useMtsTasks = (enabled: boolean) => useQuery({
  queryKey: getMtsTasksQueryKey(),
  queryFn: () => mtsService.getTasks(),
  staleTime: 30_000,
  enabled,
});

export const getMtsHistoryQueryKey = (subscriberId: number, dateFrom: string, dateTo: string) =>
  ['mts', 'history', subscriberId, dateFrom, dateTo] as const;

export const useMtsHistory = (
  subscriberId: number | null,
  dateFrom: string,
  dateTo: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: getMtsHistoryQueryKey(subscriberId ?? 0, dateFrom, dateTo),
    queryFn: () => mtsService.getHistory(subscriberId as number, dateFrom, dateTo),
    enabled: enabled && subscriberId !== null && Boolean(dateFrom) && Boolean(dateTo),
    staleTime: 30_000,
  });

// === Дополнительные бесплатные read-only данные ===

export const getMtsGroupsQueryKey = () => ['mts', 'subscriber-groups'] as const;
export const getMtsCustomFieldsQueryKey = () => ['mts', 'custom-fields'] as const;
export const getMtsRecentTracksQueryKey = (days: number) => ['mts', 'recent-tracks', days] as const;
export const getMtsRecentLocationsQueryKey = (days: number) => ['mts', 'recent-locations', days] as const;
export const getMtsRecentGlobalLocationsQueryKey = (days: number) =>
  ['mts', 'recent-global-locations', days] as const;

export const useMtsSubscriberGroups = (enabled: boolean) => useQuery({
  queryKey: getMtsGroupsQueryKey(),
  queryFn: () => mtsService.getSubscriberGroups(),
  staleTime: 5 * 60_000,
  enabled,
});

export const useMtsCustomFields = (enabled: boolean) => useQuery({
  queryKey: getMtsCustomFieldsQueryKey(),
  queryFn: () => mtsService.getCustomFields(),
  staleTime: 30 * 60_000,
  enabled,
});

export const useMtsRecentTracks = (days: number, enabled: boolean) => useQuery({
  queryKey: getMtsRecentTracksQueryKey(days),
  queryFn: () => mtsService.getRecentTracks(days),
  staleTime: 60_000,
  enabled,
});

export const useMtsRecentLocations = (days: number, enabled: boolean) => useQuery({
  queryKey: getMtsRecentLocationsQueryKey(days),
  queryFn: () => mtsService.getRecentLocations(days),
  staleTime: 60_000,
  enabled,
});

export const useMtsRecentGlobalLocations = (days: number, enabled: boolean) => useQuery({
  queryKey: getMtsRecentGlobalLocationsQueryKey(days),
  queryFn: () => mtsService.getRecentGlobalLocations(days),
  staleTime: 60_000,
  enabled,
});

// === Сотрудники с MTS-привязкой / треки / геозоны ===

export const getMtsEmployeesLinkedQueryKey = (search: string, page: number, pageSize: number) =>
  ['mts', 'employees-linked', search, page, pageSize] as const;

export const useMtsEmployeesLinked = (
  params: { search?: string; page?: number; pageSize?: number },
  enabled: boolean,
) => {
  const search = params.search || '';
  const page = params.page || 1;
  const pageSize = params.pageSize || 50;
  return useQuery({
    queryKey: getMtsEmployeesLinkedQueryKey(search, page, pageSize),
    queryFn: () => mtsService.getEmployeesLinked({ search, page, pageSize }),
    staleTime: 30_000,
    enabled,
  });
};

export const getMtsTrackDetailQueryKey = (subscriberId: number, dateFrom: string, dateTo: string) =>
  ['mts', 'track-detail', subscriberId, dateFrom, dateTo] as const;

export const useMtsTrackDetail = (
  subscriberId: number | null,
  dateFrom: string,
  dateTo: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: getMtsTrackDetailQueryKey(subscriberId ?? 0, dateFrom, dateTo),
    queryFn: () => mtsService.getTrackDetail(subscriberId as number, dateFrom, dateTo),
    enabled: enabled && subscriberId !== null && Boolean(dateFrom) && Boolean(dateTo),
    staleTime: 30_000,
  });

export const getMtsGeofencesQueryKey = () => ['mts', 'geofences'] as const;

export const useMtsGeofences = (enabled: boolean) => useQuery({
  queryKey: getMtsGeofencesQueryKey(),
  queryFn: () => mtsService.listGeofences(),
  staleTime: 60_000,
  enabled,
});

export const useCreateGeofence = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; geometry: IGeoPoint[] }) => mtsService.createGeofence(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mts', 'geofences'] }),
  });
};

export const useUpdateGeofence = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: { name?: string; geometry?: IGeoPoint[]; isActive?: boolean } }) =>
      mtsService.updateGeofence(vars.id, vars.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mts', 'geofences'] }),
  });
};

export const useDeleteGeofence = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mtsService.deleteGeofence(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mts', 'geofences'] }),
  });
};

export const useSetGeofenceAssignments = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; employeeIds: number[] }) =>
      mtsService.setGeofenceAssignments(vars.id, vars.employeeIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mts', 'geofences'] }),
  });
};

export const useAutoLinkMappings = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => mtsService.autoLinkMappings(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mts', 'mappings'] });
      qc.invalidateQueries({ queryKey: ['mts', 'employees-linked'] });
      qc.invalidateQueries({ queryKey: ['mts', 'suggestions'] });
    },
  });
};

export const getMtsSkudObjectsLiteQueryKey = () => ['mts', 'skud-objects-lite'] as const;

export const useMtsSkudObjectsLite = (enabled: boolean) => useQuery({
  queryKey: getMtsSkudObjectsLiteQueryKey(),
  queryFn: () => mtsService.getSkudObjectsLite(),
  staleTime: 5 * 60_000,
  enabled,
});

export const getMtsObjectGeofencesQueryKey = (objectId: string) =>
  ['mts', 'object-geofences', objectId] as const;

export const useMtsObjectGeofences = (objectId: string | null, enabled: boolean) => useQuery({
  queryKey: getMtsObjectGeofencesQueryKey(objectId ?? ''),
  queryFn: () => mtsService.getObjectGeofences(objectId as string),
  staleTime: 30_000,
  enabled: enabled && !!objectId,
});

export const useSetGeofenceObjects = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; skudObjectIds: string[] }) =>
      mtsService.setGeofenceObjects(vars.id, vars.skudObjectIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mts', 'geofences'] });
      qc.invalidateQueries({ queryKey: ['mts', 'object-geofences'] });
    },
  });
};

export const getMtsSummaryQueryKey = () => ['mts', 'summary'] as const;

export const useMtsSummary = (enabled: boolean) => useQuery({
  queryKey: getMtsSummaryQueryKey(),
  queryFn: () => mtsService.getSummary(),
  staleTime: 30_000,
  enabled,
});

export const useMtsRawSubscriberDebug = () => useMutation({
  mutationFn: () => mtsService.getRawSubscriberDebug(),
});

export const useMtsViolations = (
  params: { employeeId?: number | null; from?: string; to?: string; page?: number; pageSize?: number; geofenceIds?: string[] },
  enabled: boolean,
) => {
  const employeeId = params.employeeId ?? undefined;
  const geofenceKey = params.geofenceIds ? params.geofenceIds.join(',') : 'nofilter';
  return useQuery({
    queryKey: ['mts', 'violations', employeeId ?? 'all', params.from || '', params.to || '', params.page || 1, params.pageSize || 100, geofenceKey] as const,
    queryFn: () => mtsService.listGeofenceViolations({
      employeeId: employeeId ?? undefined,
      from: params.from,
      to: params.to,
      page: params.page,
      pageSize: params.pageSize,
      geofenceIds: params.geofenceIds,
    }),
    enabled,
    staleTime: 20_000,
  });
};
