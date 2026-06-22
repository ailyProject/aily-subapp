import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { FaIcon } from '../shared/Icon';
import { XAilyMarkdownViewer } from './XAilyMarkdownViewer';
import { useStreamingText } from './useStreamingText';
import './x-aily-think-viewer.css';

const PHRASES = ['Thinking...', 'Reasoning...', 'Analyzing...', 'Considering...', 'Evaluating...'];

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
  const bodyRef = useRef<HTMLDivElement>(null);
  const displayed = useStreamingText(content, !isComplete);
  const extractedTitle = useMemo(
    () => content.match(/^\s*\*\*([^*]+)\*\*/)?.[1]?.trim() || '',
    [content],
  );

  useEffect(() => {
    if (isComplete || embedded) return;
    const timer = window.setInterval(() => setPhraseIndex(value => (value + 1) % PHRASES.length), 3000);
    return () => window.clearInterval(timer);
  }, [embedded, isComplete]);

  useEffect(() => {
    if (!expanded || !bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [displayed, expanded]);

  const label = isComplete ? extractedTitle || 'Thought' : PHRASES[phraseIndex];
  return (
    <div className={`ac-think ${expanded || embedded ? 'expanded' : ''} ${!isComplete ? 'streaming' : ''} ${embedded ? 'embedded' : ''}`}>
      {!embedded && (
        <button className="ac-think-header" type="button" onClick={() => setExpanded(value => !value)}>
          <FaIcon
            className={`ac-think-icon ${isComplete ? 'done' : 'loading ac-spin'}`}
            icon={isComplete ? 'circle-check' : 'spinner-third'}
            spin={!isComplete}
          />
          <span className={`ac-think-label ${!isComplete && !expanded ? 'ac-think-shimmer' : ''}`}>{label}</span>
          <FaIcon icon="chevron-down" className="ac-think-arrow" />
        </button>
      )}
      {(expanded || embedded) && (
        <div className="ac-think-body" ref={bodyRef}>
          <XAilyMarkdownViewer content={displayed} streaming={!isComplete} />
        </div>
      )}
    </div>
  );
});
