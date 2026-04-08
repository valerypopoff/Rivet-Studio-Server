import { useCallback, useEffect, useState, type RefObject } from 'react';

export type SidebarGhostState = {
  fromX: number;
  fromY: number;
  fromWidth: number;
  fromHeight: number;
  toX: number;
  toY: number;
  toWidth: number;
  toHeight: number;
  active: boolean;
} | null;

type UseDashboardSidebarOptions = {
  collapseDurationMs: number;
  maxWidth: number;
  minWidth: number;
  openProjectCount: number;
  restoreButtonRef: RefObject<HTMLButtonElement | null>;
};

export function useDashboardSidebar(options: UseDashboardSidebarOptions) {
  const {
    collapseDurationMs,
    maxWidth,
    minWidth,
    openProjectCount,
    restoreButtonRef,
  } = options;
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarAnimating, setSidebarAnimating] = useState(false);
  const [sidebarGhost, setSidebarGhost] = useState<SidebarGhostState>(null);

  useEffect(() => {
    if (openProjectCount === 0) {
      setSidebarCollapsed(false);
      setSidebarAnimating(false);
      setSidebarGhost(null);
    }
  }, [openProjectCount]);

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

  useEffect(() => {
    if (!sidebarAnimating) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setSidebarAnimating(false);
      setSidebarGhost(null);
    }, collapseDurationMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [collapseDurationMs, sidebarAnimating]);

  const handleCollapseSidebar = useCallback(() => {
    const restoreButtonRect = restoreButtonRef.current?.getBoundingClientRect();

    if (restoreButtonRect) {
      setSidebarGhost({
        fromX: 0,
        fromY: 0,
        fromWidth: sidebarWidth,
        fromHeight: window.innerHeight,
        toX: restoreButtonRect.left,
        toY: restoreButtonRect.top,
        toWidth: restoreButtonRect.width,
        toHeight: restoreButtonRect.height,
        active: false,
      });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setSidebarGhost((prev) => prev ? { ...prev, active: true } : prev);
        });
      });
    }

    setSidebarAnimating(true);
    setSidebarCollapsed(true);
  }, [restoreButtonRef, sidebarWidth]);

  const handleRestoreSidebar = useCallback(() => {
    setSidebarCollapsed(false);
    setSidebarAnimating(false);
    setSidebarGhost(null);
  }, []);

  return {
    handleCollapseSidebar,
    handleRestoreSidebar,
    showRestoreButton: openProjectCount > 0,
    showSidebar: openProjectCount === 0 || !sidebarCollapsed,
    sidebarCollapsed,
    sidebarGhost,
    sidebarResizing,
    sidebarWidth,
  };
}
