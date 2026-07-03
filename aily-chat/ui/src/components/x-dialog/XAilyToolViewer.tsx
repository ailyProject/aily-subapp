import { ChatPart } from '../../protocol';
import { XAilyMarkdownViewer } from './XAilyMarkdownViewer';
import './x-aily-activity-viewers.scss';

const LARGE_TOOL_OUTPUT_THRESHOLD = 12_000;

export function XAilyToolViewer({ part }: { part: ChatPart }) {
  const output = String(part.output || part.content || part.text || '');
  return (
    <div className="x-aily-tool-viewer">
      {part.args !== undefined && <ActivitySection title="输入" value={part.args} />}
      {output && (
        <ActivitySection title="输出">
          <div className="x-aily-tool-output-detail">
            {output.length >= LARGE_TOOL_OUTPUT_THRESHOLD
              ? <pre className="x-aily-tool-output-plain">{output}</pre>
              : <XAilyMarkdownViewer content={output} streaming={part.state === 'doing'} />}
          </div>
        </ActivitySection>
      )}
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
