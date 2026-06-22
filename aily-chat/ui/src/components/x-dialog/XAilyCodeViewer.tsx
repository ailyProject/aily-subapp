import { memo } from 'react';
import { useStreamingText } from './useStreamingText';
import './x-aily-code-viewer.css';

export const XAilyCodeViewer = memo(function XAilyCodeViewer({
  children,
  block,
  lang = '',
  streaming = false,
}: {
  children: string;
  block: boolean;
  lang?: string;
  streaming?: boolean;
}) {
  const content = useStreamingText(children, streaming);
  if (!block) return <code className="x-aily-inline-code">{content}</code>;
  return (
    <div className="x-aily-code-viewer" data-streaming={streaming}>
      {lang && <div className="x-aily-code-language">{lang}</div>}
      <pre><code className={`language-${lang}`}>{content}</code></pre>
    </div>
  );
});
