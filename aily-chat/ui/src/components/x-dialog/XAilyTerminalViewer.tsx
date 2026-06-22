import { useEffect, useRef } from 'react';
import { ChatPart } from '../../protocol';
import { useStreamingText } from './useStreamingText';
import './x-aily-activity-viewers.css';

export function XAilyTerminalViewer({ part }: { part: ChatPart }) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const output = useStreamingText(part.output || part.content || '', part.isRunning === true);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [output]);
  return (
    <div className="x-aily-terminal-viewer" data-running={part.isRunning === true}>
      {part.command && <div className="x-aily-terminal-command"><span>$</span>{part.command}</div>}
      <pre ref={bodyRef}>{output}{part.stderr && <span className="x-aily-terminal-stderr">{part.stderr}</span>}</pre>
      {!part.isRunning && part.exitCode !== undefined && <div className="x-aily-terminal-exit">exit {part.exitCode}</div>}
    </div>
  );
}
