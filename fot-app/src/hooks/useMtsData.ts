import { useQuery } from '@tanstack/react-query';
import { mtsService } from '../services/mtsService';

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
  staleTime: 60_000,
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
