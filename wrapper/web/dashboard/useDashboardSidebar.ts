import { useCallback, useEffect, useRef, useState, type TransitionEvent } from 'react';

const SIDEBAR_REVEAL_FALLBACK_MS = 240;

type UseDashboardSidebarOptions = {
  maxWidth: number;
  minWidth: number;
};

export function useDashboardSidebar(options: UseDashboardSidebarOptions) {
  const {
    maxWidth,
    minWidth,
  } = options;
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarContentVisible, setSidebarContentVisible] = useState(true);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const revealTimeoutRef = useRef<number | undefined>();

  const clearRevealTimeout = useCallback(() => {
    if (revealTimeoutRef.current === undefined) {
      return;
    }

    window.clearTimeout(revealTimeoutRef.current);
    revealTimeoutRef.current = undefined;
  }, []);

  const revealSidebarContent = useCallback(() => {
    clearRevealTimeout();
    setSidebarContentVisible(true);
  }, [clearRevealTimeout]);

  const scheduleSidebarContentReveal = useCallback(() => {
    clearRevealTimeout();
    revealTimeoutRef.current = window.setTimeout(revealSidebarContent, SIDEBAR_REVEAL_FALLBACK_MS);
  }, [clearRevealTimeout, revealSidebarContent]);

  useEffect(() => clearRevealTimeout, [clearRevealTimeout]);

  useEffect(() => {
    if (sidebarCollapsed) {
      setSidebarResizing(false);
      return;
    }

    const handleMouseMove = (event: MouseEvent) => {
      setSidebarWidth(Math.min(maxWidth, Math.max(minWidth, event.clientX)));
    };

    const stopResize = () => {
      setSidebarResizing(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', stopResize);
    };

    const handleResizeStart = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.dashboard-sidebar-resizer')) {
        return;
      }

      event.preventDefault();
      setSidebarResizing(true);
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', stopResize);
    };

    window.addEventListener('mousedown', handleResizeStart);

    return () => {
      window.removeEventListener('mousedown', handleResizeStart);
      stopResize();
    };
  }, [maxWidth, minWidth, sidebarCollapsed]);

  const handleSidebarTransitionEnd = useCallback((event: TransitionEvent<HTMLElement>) => {
    if (event.currentTarget !== event.target || sidebarCollapsed) {
      return;
    }

    if (event.propertyName !== 'width' && event.propertyName !== 'flex-basis') {
      return;
    }

    revealSidebarContent();
  }, [revealSidebarContent, sidebarCollapsed]);

  const handleToggleSidebar = useCallback(() => {
    if (sidebarCollapsed) {
      setSidebarContentVisible(false);
      setSidebarCollapsed(false);
      scheduleSidebarContentReveal();
      return;
    }

    clearRevealTimeout();
    setSidebarContentVisible(false);
    setSidebarCollapsed(true);
  }, [clearRevealTimeout, scheduleSidebarContentReveal, sidebarCollapsed]);

  return {
    handleSidebarTransitionEnd,
    handleToggleSidebar,
    sidebarCollapsed,
    sidebarContentVisible,
    sidebarResizing,
    sidebarWidth,
  };
}
