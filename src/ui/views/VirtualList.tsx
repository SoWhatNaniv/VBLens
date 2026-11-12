import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

export interface VirtualListHandle { scrollToIndex(i: number, center?: boolean): void; el(): HTMLDivElement | null }

interface Props {
  count: number;
  rowHeight: number;
  render: (i: number, top: number) => React.ReactNode;
  className?: string;
  width?: number;
  overscan?: number;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  onScroll?: (top: number) => void;
  initialIndex?: number;
  children?: React.ReactNode;
  testId?: string;
}

/** Minimal fixed-row-height virtual scroller. */
export const VirtualList = forwardRef<VirtualListHandle, Props>(function VirtualList(
  { count, rowHeight, render, className, width, overscan = 12, onKeyDown, onScroll, initialIndex, children, testId }, ref,
) {
  const el = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [h, setH] = useState(600);
  useImperativeHandle(ref, () => ({
    scrollToIndex(i: number, center = true) {
      const e = el.current;
      if (!e) return;
      const y = i * rowHeight;
      if (center) e.scrollTop = Math.max(0, y - e.clientHeight / 2 + rowHeight * 2);
      else if (y < e.scrollTop || y > e.scrollTop + e.clientHeight - rowHeight) e.scrollTop = Math.max(0, y - rowHeight * 3);
    },
    el: () => el.current,
  }));
  useLayoutEffect(() => {
    const e = el.current!;
    setH(e.clientHeight);
    const ro = new ResizeObserver(() => setH(e.clientHeight));
    ro.observe(e);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (initialIndex !== undefined && initialIndex >= 0 && el.current) {
      el.current.scrollTop = Math.max(0, initialIndex * rowHeight - el.current.clientHeight / 3);
      setTop(el.current.scrollTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialIndex]);
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((top + h) / rowHeight) + overscan);
  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) rows.push(render(i, i * rowHeight));
  return (
    <div ref={el} className={className} tabIndex={0} data-testid={testId}
      onScroll={e => { const t = (e.target as HTMLDivElement).scrollTop; setTop(t); onScroll?.(t); }}
      onKeyDown={onKeyDown}>
      {/* overlays (find bar) live in a zero-height layer pinned to the visible top-left,
          so they stay on screen however far the list is scrolled */}
      <div className="vl-overlay">{children}</div>
      <div className="inner" style={{ height: count * rowHeight + 40, width }}>{rows}</div>
    </div>
  );
});
