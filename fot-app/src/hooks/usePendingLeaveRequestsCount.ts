import { useEffect, useState } from 'react';
import { leaveRequestService } from '../services/leaveRequestService';
import { wsService } from '../services/websocket';
import { useAuth } from '../contexts/AuthContext';

export const usePendingLeaveRequestsCount = (): number => {
  const { token, isAuthenticated, isApproved, canViewPage } = useAuth();
  const canView = canViewPage('/leave-requests');
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!canView) return undefined;
    let active = true;
    leaveRequestService.getPendingCount()
      .then(({ count }) => { if (active) setPendingCount(count); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [canView]);

  useEffect(() => {
    if (canView && isAuthenticated && isApproved && token) {
      wsService.connect(token, 'leave-req-badge');
      return () => { wsService.disconnect('leave-req-badge'); };
    }
    return undefined;
  }, [canView, isAuthenticated, isApproved, token]);

  useEffect(() => {
    if (!canView) return undefined;
    const off = wsService.on('leave_request_pending_changed', () => {
      leaveRequestService.getPendingCount()
        .then(({ count }) => setPendingCount(count))
        .catch(() => undefined);
    });
    return () => { off(); };
  }, [canView]);

  return pendingCount;
};
