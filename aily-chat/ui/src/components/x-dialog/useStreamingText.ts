import { useEffect, useRef, useState } from 'react';

const FRAME_BUDGET_MS = 12;

export function useStreamingText(content: string, streaming: boolean): string {
  const [visible, setVisible] = useState(content);
  const visibleRef = useRef(content);
  const targetRef = useRef(content);
  const frameRef = useRef(0);

  useEffect(() => {
    targetRef.current = content;
    if (!streaming || !content.startsWith(visibleRef.current)) {
      visibleRef.current = content;
      setVisible(content);
      return;
    }

    if (frameRef.current || visibleRef.current === content) return;
    const render = () => {
      const started = performance.now();
      let next = visibleRef.current;
      const target = targetRef.current;
      while (next.length < target.length && performance.now() - started < FRAME_BUDGET_MS) {
        const remaining = target.length - next.length;
        const step = Math.max(1, Math.min(remaining, Math.ceil(remaining / 5)));
        next = target.slice(0, next.length + step);
      }
      visibleRef.current = next;
      setVisible(next);
      frameRef.current = next.length < targetRef.current.length
        ? requestAnimationFrame(render)
        : 0;
    };
    frameRef.current = requestAnimationFrame(render);
    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, [content, streaming]);

  return visible;
}
