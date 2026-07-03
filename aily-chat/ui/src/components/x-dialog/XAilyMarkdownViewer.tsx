import { memo, type ReactNode } from 'react';
import { XMarkdown, type ComponentProps } from '@ant-design/x-markdown';
import { FaIcon } from '../shared/Icon';
import './x-aily-markdown-viewer.scss';

type AilyResourceKind = 'board' | 'library';

interface AilyResourceData {
  name: string;
  nickname?: string;
  displayName?: string;
  description?: string;
  icon?: string;
  url?: string;
  version?: string;
  category?: string;
  brand?: string;
  author?: string;
}

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

  const resourceKind = ailyResourceKind(lang);
  if (resourceKind) {
    const resource = parseAilyResource(content, resourceKind);
    if (resource) {
      return <AilyResourceCard kind={resourceKind} resource={resource} />;
    }
    return <AilyResourceCardSkeleton kind={resourceKind} loading={streamStatus === 'loading'} />;
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

const AilyResourceCardSkeleton = memo(function AilyResourceCardSkeleton({
  kind,
  loading,
}: {
  kind: AilyResourceKind;
  loading: boolean;
}) {
  return (
    <span className="x-aily-resource-card x-aily-resource-card-skeleton" data-kind={kind} data-loading={loading}>
      <span className="x-aily-resource-icon">
        <FaIcon iconClass={kind === 'board' ? 'fa-light fa-microchip' : 'fa-light fa-cube'} />
      </span>
      <span className="x-aily-resource-body">
        <span className="x-aily-resource-title-row">
          <span className="x-aily-resource-skeleton-line x-aily-resource-skeleton-title" />
          <span className="x-aily-resource-kind">{kind === 'board' ? '主板' : '库'}</span>
        </span>
        <span className="x-aily-resource-skeleton-line x-aily-resource-skeleton-name" />
        <span className="x-aily-resource-skeleton-line x-aily-resource-skeleton-description" />
      </span>
      <span className="x-aily-resource-status">{loading ? '生成中' : '待解析'}</span>
    </span>
  );
});

const AilyResourceCard = memo(function AilyResourceCard({
  kind,
  resource,
}: {
  kind: AilyResourceKind;
  resource: AilyResourceData;
}) {
  const title = resource.nickname || resource.displayName || resource.name;
  const detail = resource.description || resource.category || resource.brand || resource.author || '';
  const meta = [resource.version, resource.category, resource.brand || resource.author].filter(Boolean).join(' · ');
  const iconClass = kind === 'board'
    ? 'fa-light fa-microchip'
    : resource.icon || 'fa-light fa-cube';

  return (
    <span className="x-aily-resource-card" data-kind={kind}>
      <span className="x-aily-resource-icon">
        <FaIcon iconClass={iconClass} />
      </span>
      <span className="x-aily-resource-body">
        <span className="x-aily-resource-title-row">
          <span className="x-aily-resource-title">{title}</span>
          <span className="x-aily-resource-kind">{kind === 'board' ? '主板' : '库'}</span>
        </span>
        <span className="x-aily-resource-name">{resource.name}</span>
        {detail && <span className="x-aily-resource-description">{detail}</span>}
        {meta && <span className="x-aily-resource-meta">{meta}</span>}
      </span>
      {resource.url && (
        <a className="x-aily-resource-link" href={resource.url} target="_blank" rel="noreferrer" title="查看文档">
          <FaIcon icon="book-open" />
        </a>
      )}
    </span>
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

function ailyResourceKind(value: string): AilyResourceKind | null {
  const lang = normalizeLanguage(value);
  if (lang === 'aily-board') return 'board';
  if (lang === 'aily-library') return 'library';
  return null;
}

function parseAilyResource(content: string, kind: AilyResourceKind): AilyResourceData | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const candidate = readRecord(parsed);
    const resource = readRecord(candidate?.[kind === 'board' ? 'board' : 'library']) || candidate;
    const name = readString(resource?.name) || readString(resource?.package);
    if (!name) return null;
    return {
      name,
      nickname: readString(resource?.nickname),
      displayName: readString(resource?.displayName),
      description: readString(resource?.description),
      icon: readString(resource?.icon),
      url: readString(resource?.url),
      version: readString(resource?.version),
      category: readString(resource?.category),
      brand: readString(resource?.brand),
      author: readString(resource?.author),
    };
  } catch {
    return null;
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
