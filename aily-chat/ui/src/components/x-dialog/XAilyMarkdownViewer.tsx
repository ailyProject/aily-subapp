import { memo, type ReactNode } from 'react';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import './x-aily-markdown-viewer.scss';

const MarkdownCode = memo(function MarkdownCode({
  children,
  block = false,
  lang = '',
  streamStatus,
}: ComponentProps) {
  const content = readText(children);
  if (!block) {
    return <code className="x-aily-inline-code">{content}</code>;
  }

  return (
    <code
      className={`x-aily-markdown-code language-${normalizeLanguage(lang)}`}
      data-lang={lang || undefined}
      data-streaming={streamStatus === 'loading'}
    >
      {content}
    </code>
  );
});

const MARKDOWN_COMPONENTS = {
  code: MarkdownCode,
};

export const XAilyMarkdownViewer = memo(function XAilyMarkdownViewer({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  return (
    <XMarkdown
      content={content}
      rootClassName={`x-aily-markdown-viewer ${streaming ? 'x-aily-markdown-viewer-streaming' : ''}`}
      components={MARKDOWN_COMPONENTS}
      streaming={{
        hasNextChunk: streaming,
        enableAnimation: false,
      }}
      disableDefaultStyles={['pre', 'code']}
      openLinksInNewTab
      escapeRawHtml
    />
  );
});

function readText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(readText).join('');
  }
  return '';
}

function normalizeLanguage(value: string): string {
  return value.trim().split(/\s+/, 1)[0]?.replace(/[^\w-]/g, '') || 'text';
}
