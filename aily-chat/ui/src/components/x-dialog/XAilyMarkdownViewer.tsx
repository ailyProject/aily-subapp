import './x-aily-markdown-viewer.css';
import { XAilyCodeViewer } from './XAilyCodeViewer';
import { useStreamingText } from './useStreamingText';

export function XAilyMarkdownViewer({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  const displayed = useStreamingText(content, streaming);
  const blocks = tokenizeMarkdown(displayed);
  return (
    <div className="x-aily-markdown-viewer" data-streaming={streaming}>
      {blocks.map((block, index) => block.kind === 'code'
        ? <XAilyCodeViewer key={index} block lang={block.lang} streaming={streaming && block.open} children={block.content} />
        : block.content.split(/\n{2,}/).filter(Boolean).map((paragraph, paragraphIndex) => (
          <p key={`${index}-${paragraphIndex}`}>{renderInlineMarkdown(paragraph, streaming)}</p>
        )))}
    </div>
  );
}

function renderInlineMarkdown(text: string, streaming: boolean) {
  return text.split(/(\*\*.*?\*\*|`.*?`)/g).map((chunk, index) => {
    if (chunk.startsWith('**') && chunk.endsWith('**')) return <strong key={index}>{chunk.slice(2, -2)}</strong>;
    if (chunk.startsWith('`') && chunk.endsWith('`')) return <XAilyCodeViewer key={index} block={false} streaming={streaming} children={chunk.slice(1, -1)} />;
    return chunk;
  });
}

function tokenizeMarkdown(content: string): Array<{ kind: 'text' | 'code'; content: string; lang?: string; open?: boolean }> {
  const result: Array<{ kind: 'text' | 'code'; content: string; lang?: string; open?: boolean }> = [];
  let offset = 0;
  while (offset < content.length) {
    const fence = content.indexOf('```', offset);
    if (fence < 0) {
      result.push({ kind: 'text', content: content.slice(offset) });
      break;
    }
    if (fence > offset) result.push({ kind: 'text', content: content.slice(offset, fence) });
    const headerEnd = content.indexOf('\n', fence + 3);
    if (headerEnd < 0) {
      result.push({ kind: 'code', content: '', lang: content.slice(fence + 3).trim(), open: true });
      break;
    }
    const lang = content.slice(fence + 3, headerEnd).trim();
    const close = content.indexOf('```', headerEnd + 1);
    if (close < 0) {
      result.push({ kind: 'code', content: content.slice(headerEnd + 1), lang, open: true });
      break;
    }
    result.push({ kind: 'code', content: content.slice(headerEnd + 1, close).replace(/\n$/, ''), lang, open: false });
    offset = close + 3;
  }
  return result.length ? result : [{ kind: 'text', content }];
}
