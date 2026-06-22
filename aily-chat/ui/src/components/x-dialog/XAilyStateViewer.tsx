import { ChatPart } from '../../protocol';
import './x-aily-activity-viewers.css';

export function XAilyStateViewer({ part }: { part: ChatPart }) {
  return (
    <div className="x-aily-state-viewer">
      {typeof part.progress === 'number' && (
        <div className="x-aily-state-progress"><span style={{ width: `${Math.max(0, Math.min(100, part.progress))}%` }} /></div>
      )}
      <div className="x-aily-state-copy">{part.text || part.content || part.detail}</div>
      {part.metadata && <pre>{JSON.stringify(part.metadata, null, 2)}</pre>}
    </div>
  );
}
