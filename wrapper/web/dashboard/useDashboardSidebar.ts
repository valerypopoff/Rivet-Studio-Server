import { useCallback, useEffect, useState } from 'react';

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
  const [sidebarResizing, setSidebarResizing] = useState(false);

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

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => !prev);
  }, []);

  return {
    handleToggleSidebar,
    sidebarCollapsed,
    sidebarResizing,
    sidebarWidth,
  };
}
