import { ChatPart } from '../../protocol';
import { XAilyMarkdownViewer } from './XAilyMarkdownViewer';
import './x-aily-activity-viewers.css';

export function XAilyToolViewer({ part }: { part: ChatPart }) {
  return (
    <div className="x-aily-tool-viewer">
      {part.args !== undefined && <ActivitySection title="输入" value={part.args} />}
      {(part.output || part.content) && <ActivitySection title="输出"><XAilyMarkdownViewer content={String(part.output || part.content || '')} streaming={part.state === 'doing'} /></ActivitySection>}
      {part.detail && <div className="x-aily-activity-note">{part.detail}</div>}
    </div>
  );
}

function ActivitySection({ title, value, children }: { title: string; value?: unknown; children?: React.ReactNode }) {
  return <section className="x-aily-activity-section"><div className="x-aily-activity-section-title">{title}</div>{children || <pre>{format(value)}</pre>}</section>;
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ''); }
}
