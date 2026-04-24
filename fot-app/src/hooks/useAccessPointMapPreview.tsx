import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import { travelTimeService } from '../services/travelTimeService';
import type { IAccessPointMapView } from '../types';

const POPOVER_MARGIN_PX = 8;
const POPOVER_GAP_PX = 8;
const POPOVER_DEFAULT_WIDTH_PX = 220;
const POPOVER_DEFAULT_HEIGHT_PX = 196;
const CLOSE_DELAY_MS = 120;

const previewCache = new Map<string, IAccessPointMapView | null>();
const previewRequests = new Map<string, Promise<IAccessPointMapView | null>>();

async function loadAccessPointPreview(accessPointName: string): Promise<IAccessPointMapView | null> {
  const cacheKey = accessPointName.trim();
  if (!cacheKey) return null;

  if (previewCache.has(cacheKey)) {
    return previewCache.get(cacheKey) ?? null;
  }

  const inFlight = previewRequests.get(cacheKey);
  if (inFlight) return inFlight;

  const request = travelTimeService.getAccessPointMap(cacheKey)
    .then(data => {
      previewCache.set(cacheKey, data);
      return data;
    })
    .catch(() => {
      previewCache.set(cacheKey, null);
      return null;
    })
    .finally(() => {
      previewRequests.delete(cacheKey);
    });

  previewRequests.set(cacheKey, request);
  return request;
}

export interface IAccessPointMapPreviewState<T extends HTMLElement = HTMLElement> {
  open: boolean;
  loading: boolean;
  preview: IAccessPointMapView | null;
  popoverStyle: CSSProperties | null;
  wrapperRef: RefObject<T | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
  openPreview: () => void;
  scheduleClose: () => void;
}

export const useAccessPointMapPreview = <T extends HTMLElement = HTMLElement>(
  accessPointName: string,
  enabled: boolean,
): IAccessPointMapPreviewState<T> => {
  const normalizedName = accessPointName.trim();
  const cachedPreview = useMemo(
    () => (normalizedName ? previewCache.get(normalizedName) ?? null : null),
    [normalizedName],
  );
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<IAccessPointMapView | null>(cachedPreview);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);
  const wrapperRef = useRef<T | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const closeTimeoutRef = useRef<number | null>(null);

  const clearCloseTimeout = useCallback(() => {
    if (closeTimeoutRef.current == null || typeof window === 'undefined') {
      return;
    }
    window.clearTimeout(closeTimeoutRef.current);
    closeTimeoutRef.current = null;
  }, []);

  const openPreview = useCallback(() => {
    if (!enabled || !normalizedName) return;
    clearCloseTimeout();
    setOpen(true);
  }, [clearCloseTimeout, enabled, normalizedName]);

  const scheduleClose = useCallback(() => {
    if (typeof window === 'undefined') {
      setOpen(false);
      return;
    }
    clearCloseTimeout();
    closeTimeoutRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimeoutRef.current = null;
    }, CLOSE_DELAY_MS);
  }, [clearCloseTimeout]);

  const updatePopoverPosition = useCallback(() => {
    if (typeof window === 'undefined' || !wrapperRef.current) {
      return;
    }

    const anchorRect = wrapperRef.current.getBoundingClientRect();
    const popoverHeight = popoverRef.current?.offsetHeight ?? POPOVER_DEFAULT_HEIGHT_PX;
    const width = Math.min(
      POPOVER_DEFAULT_WIDTH_PX,
      Math.max(160, window.innerWidth - POPOVER_MARGIN_PX * 2),
    );
    const left = Math.min(
      Math.max(anchorRect.right - width, POPOVER_MARGIN_PX),
      window.innerWidth - width - POPOVER_MARGIN_PX,
    );

    const preferredTop = anchorRect.bottom + POPOVER_GAP_PX;
    const top = preferredTop + popoverHeight <= window.innerHeight - POPOVER_MARGIN_PX
      ? preferredTop
      : Math.max(
          POPOVER_MARGIN_PX,
          anchorRect.top - popoverHeight - POPOVER_GAP_PX,
        );

    setPopoverStyle({ left, top, width });
  }, []);

  useEffect(() => {
    setPreview(cachedPreview);
  }, [cachedPreview, normalizedName]);

  useEffect(() => () => {
    clearCloseTimeout();
  }, [clearCloseTimeout]);

  useEffect(() => {
    if (!enabled || !open || !normalizedName) return;
    if (previewCache.has(normalizedName)) {
      setPreview(previewCache.get(normalizedName) ?? null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void loadAccessPointPreview(normalizedName)
      .then(data => {
        if (!cancelled) setPreview(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, normalizedName, open]);

  useEffect(() => {
    if (!open) {
      setPopoverStyle(null);
      return;
    }

    updatePopoverPosition();

    if (typeof window === 'undefined') {
      return;
    }

    const rafId = window.requestAnimationFrame(updatePopoverPosition);
    window.addEventListener('resize', updatePopoverPosition);
    window.addEventListener('scroll', updatePopoverPosition, true);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', updatePopoverPosition);
      window.removeEventListener('scroll', updatePopoverPosition, true);
    };
  }, [loading, open, preview, updatePopoverPosition]);

  return {
    open: open && !!normalizedName && enabled,
    loading,
    preview,
    popoverStyle,
    wrapperRef,
    popoverRef,
    openPreview,
    scheduleClose,
  };
};
