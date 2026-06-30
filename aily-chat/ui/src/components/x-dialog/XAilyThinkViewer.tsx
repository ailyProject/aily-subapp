import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FaIcon } from '../shared/Icon';
import { t } from '../../protocol';
import { XAilyMarkdownViewer } from './XAilyMarkdownViewer';
import { useStreamingText } from './useStreamingText';
import './x-aily-think-viewer.scss';

export const XAilyThinkViewer = memo(function XAilyThinkViewer({
  content,
  isComplete,
  embedded = false,
}: {
  content: string;
  isComplete: boolean;
  embedded?: boolean;
}) {
  const [expanded, setExpanded] = useState(embedded);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const phrases = [
    t('THINKING', '思考中'),
    t('REASONING', '推理中'),
    t('ANALYZING', '分析中'),
    t('CONSIDERING', '考虑中'),
    t('EVALUATING', '评估中'),
  ];
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const displayed = useStreamingText(content, !isComplete);
  const extractedTitle = useMemo(
    () => content.match(/^\s*\*\*([^*]+)\*\*/)?.[1]?.trim() || '',
    [content],
  );

  useEffect(() => {
    if (isComplete || embedded) return;
    const timer = window.setInterval(() => setPhraseIndex(value => (value + 1) % phrases.length), 3000);
    return () => window.clearInterval(timer);
  }, [embedded, isComplete, phrases.length]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!expanded || !body || !stickToBottomRef.current) return;
    scrollToBottom(body);
  }, [displayed, expanded]);

  useEffect(() => {
    const body = bodyRef.current;
    const contentElement = body?.firstElementChild;
    if (!expanded || !body || !contentElement || typeof ResizeObserver === 'undefined') {
      return;
    }

    let frameId = 0;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current || frameId !== 0) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        if (stickToBottomRef.current) {
          scrollToBottom(body);
        }
      });
    });
    observer.observe(contentElement);
    return () => {
      observer.disconnect();
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [expanded]);

  function markUserScrollIntent(): void {
    userScrollIntentUntilRef.current = Date.now() + 250;
  }

  function handleScroll(): void {
    const body = bodyRef.current;
    if (!body) {
      return;
    }
    const distanceFromBottom = Math.max(0, body.scrollHeight - body.clientHeight - body.scrollTop);
    if (distanceFromBottom <= 20) {
      stickToBottomRef.current = true;
      return;
    }
    if (!programmaticScrollRef.current && Date.now() <= userScrollIntentUntilRef.current) {
      stickToBottomRef.current = false;
    }
  }

  function scrollToBottom(body: HTMLDivElement): void {
    programmaticScrollRef.current = true;
    body.scrollTop = body.scrollHeight;
    window.requestAnimationFrame(() => {
      if (stickToBottomRef.current) {
        body.scrollTop = body.scrollHeight;
      }
      window.requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    });
  }

  const label = isComplete ? extractedTitle || t('THOUGHT', '思考') : phrases[phraseIndex];
  return (
    <div className={`ac-think ${expanded || embedded ? 'expanded' : ''} ${!isComplete ? 'streaming' : ''} ${embedded ? 'embedded' : ''}`}>
      {!embedded && (
        <button className="ac-think-header" type="button" onClick={() => setExpanded(value => {
          const next = !value;
          if (next) {
            stickToBottomRef.current = true;
          }
          return next;
        })}>
          <FaIcon
            icon={isComplete ? 'circle-check' : 'spinner-third'}
            spin={!isComplete}
            className={`ac-think-icon ${isComplete ? 'done' : 'loading ac-spin'}`}
          />
          <span className={`ac-think-label ${!isComplete && !expanded ? 'ac-think-shimmer' : ''}`}>{label}</span>
          <FaIcon icon={expanded ? 'chevron-up' : 'chevron-down'} className="ac-think-arrow" />
        </button>
      )}
      {(expanded || embedded) && (
        <div
          className="ac-think-body"
          ref={bodyRef}
          onScroll={handleScroll}
          onWheel={markUserScrollIntent}
          onTouchMove={markUserScrollIntent}
          onPointerDown={markUserScrollIntent}
        >
          <XAilyMarkdownViewer content={displayed} streaming={!isComplete} />
        </div>
      )}
    </div>
  );
});
