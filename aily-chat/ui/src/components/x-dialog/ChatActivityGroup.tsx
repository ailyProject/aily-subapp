import { memo, MutableRefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChatPart, PartState, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import { XAilyStateViewer } from './XAilyStateViewer';
import { XAilyTerminalViewer } from './XAilyTerminalViewer';
import { XAilyThinkViewer } from './XAilyThinkViewer';
import { XAilyToolViewer } from './XAilyToolViewer';
import { XAilyConfirmationViewer } from './XAilyConfirmationViewer';
import './chat-activity-group.scss';

interface PartIconPresentation {
  iconClass: string;
  spin: boolean;
  color: string;
  shellLoading: boolean;
}

const GROUP_COLLAPSE_DELAY_MS = 520;

export const ChatActivityGroup = memo(function ChatActivityGroup({
  parts,
  doing,
}: {
  parts: ChatPart[];
  doing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detailVisible, setDetailVisible] = useState(false);
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const autoScrollEnabledRef = useRef(true);
  const lastScrollHeightRef = useRef(0);
  const ignoreNextScrollRef = useRef(false);
  const hasAutoOpenedRef = useRef(false);
  const collapseDelayRef = useRef<number | null>(null);
  const intrinsicState = getActivityGroupState(parts);
  const live = doing && intrinsicState === 'doing';
  const groupState = live ? 'doing' : intrinsicState;
  const header = groupHeader(parts);
  const type = normalizeType(parts[0]?.type);
  const firstItemIsTool = type === 'tool';

  useEffect(() => {
    if (live) {
      clearGroupCollapseTimer(collapseDelayRef);
      hasAutoOpenedRef.current = true;
      setDetailVisible(true);
      setExpanded(true);
      autoScrollEnabledRef.current = true;
      lastScrollHeightRef.current = 0;
      setShowTopFade(false);
      setShowBottomFade(false);
      return;
    }

    if (!hasAutoOpenedRef.current) {
      return;
    }

    clearGroupCollapseTimer(collapseDelayRef);
    collapseDelayRef.current = window.setTimeout(() => {
      setExpanded(false);
      setShowTopFade(false);
      setShowBottomFade(false);
    }, GROUP_COLLAPSE_DELAY_MS);

    return () => clearGroupCollapseTimer(collapseDelayRef);
  }, [live]);

  useEffect(() => {
    return () => clearGroupCollapseTimer(collapseDelayRef);
  }, []);

  useLayoutEffect(() => {
    if (!expanded || !live) {
      setShowTopFade(false);
      setShowBottomFade(false);
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const scrollHeight = viewport.scrollHeight;
    if (!scrollHeight) {
      return;
    }

    if (scrollHeight === lastScrollHeightRef.current && !autoScrollEnabledRef.current) {
      updateDetailViewportFades(viewport, setShowTopFade, setShowBottomFade);
      return;
    }

    lastScrollHeightRef.current = scrollHeight;
    if (!autoScrollEnabledRef.current) {
      updateDetailViewportFades(viewport, setShowTopFade, setShowBottomFade);
      return;
    }

    const maxScrollTop = Math.max(0, scrollHeight - viewport.clientHeight);
    if (maxScrollTop <= 0 || viewport.scrollTop >= maxScrollTop - 1) {
      updateDetailViewportFades(viewport, setShowTopFade, setShowBottomFade);
      return;
    }

    ignoreNextScrollRef.current = true;
    viewport.scrollTop = maxScrollTop;
    updateDetailViewportFades(viewport, setShowTopFade, setShowBottomFade);
  }, [expanded, live, parts]);

  function toggleExpanded(): void {
    clearGroupCollapseTimer(collapseDelayRef);
    setExpanded(value => {
      const next = !value;
      if (next) {
        setDetailVisible(true);
      } else {
        setShowTopFade(false);
        setShowBottomFade(false);
      }
      if (next && live) {
        autoScrollEnabledRef.current = true;
        lastScrollHeightRef.current = 0;
      }
      return next;
    });
  }

  function handleViewportScroll(): void {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    if (ignoreNextScrollRef.current) {
      ignoreNextScrollRef.current = false;
      updateDetailViewportFades(viewport, setShowTopFade, setShowBottomFade);
      return;
    }

    const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    autoScrollEnabledRef.current = maxScrollTop <= 0 || viewport.scrollTop >= maxScrollTop - 10;
    updateDetailViewportFades(viewport, setShowTopFade, setShowBottomFade);
  }

  return (
    <section
      className={[
        'cag',
        expanded ? 'cag-expanded' : '',
        live ? 'cag-fixed-streaming' : '',
        showTopFade ? 'cag-fade-top' : '',
        showBottomFade ? 'cag-fade-bottom' : '',
        !firstItemIsTool ? 'cag-first-item-not-tool' : '',
      ].filter(Boolean).join(' ')}
      data-state={groupState}
      data-type={type}
    >
      <button className="cag-header" aria-expanded={expanded} onClick={toggleExpanded}>
        <span className={`cag-icon-shell ${live ? 'loading-icon lloading' : ''}`}>
          {groupState === 'done'
            ? <FaIcon icon="circle-check" className="cag-item-icon" />
            : groupState === 'error'
              ? <FaIcon icon="circle-exclamation" className="cag-item-icon" />
              : <FaIcon icon="spinner-third" className="cag-item-icon" />}
        </span>
        <span className="cag-group-default-header">
          <span className="cag-title">{header.title}</span>
          {header.detail && <span className={`cag-subtitle ${live && !expanded ? 'cag-shimmer' : ''}`}>{header.detail}</span>}
        </span>
        <span className="cag-chevron-wrap"><FaIcon icon="chevron-down" className="cag-chevron" /></span>
      </button>
      {detailVisible && (
        <div
          ref={viewportRef}
          className={[
            'cag-detail-viewport',
            expanded ? 'cag-detail-viewport-open' : 'cag-detail-viewport-collapsing',
            live ? 'cag-detail-viewport-fixed' : '',
          ].filter(Boolean).join(' ')}
          onScroll={handleViewportScroll}
        >
          <div className="cag-list">
            {parts.map((part, index) => {
              const partType = normalizeType(part.type);
              const isFirst = index === 0;
              const isLast = index === parts.length - 1;
              const isOnly = parts.length === 1;
              return (
                <ChatActivityItem
                  key={part.id}
                  part={part}
                  partType={partType}
                  className={`cag-item ${partType === 'tool' ? 'cag-item-tool' : 'cag-item-non-tool'} ${isFirst ? 'cag-item-first' : ''} ${isLast ? 'cag-item-last' : ''} ${isOnly ? 'cag-item-only' : ''}`}
                />
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
});

function clearGroupCollapseTimer(collapseDelayRef: MutableRefObject<number | null>): void {
  if (collapseDelayRef.current !== null) {
    window.clearTimeout(collapseDelayRef.current);
    collapseDelayRef.current = null;
  }
}

const ChatActivityItem = memo(function ChatActivityItem({
  part,
  partType,
  className,
}: {
  part: ChatPart;
  partType: string;
  className: string;
}) {
  const icon = getPartIconPresentation(part, partType);
  const hasDetail = hasDetailContent(part, partType);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [detailRenderReady, setDetailRenderReady] = useState(false);

  useEffect(() => {
    if (!detailExpanded || detailRenderReady) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => setDetailRenderReady(true));
    return () => window.cancelAnimationFrame(frameId);
  }, [detailExpanded, detailRenderReady]);

  return (
    <div className={className} data-kind={partType}>
      <span
        className={`cag-item-icon-shell ${icon.shellLoading ? 'loading-icon lloading' : ''}`}
        style={{ color: icon.color }}
      >
        <FaIcon iconClass={icon.iconClass} spin={icon.spin} className="cag-item-icon" />
      </span>
      <div className="cag-item-body">
        {partType === 'thinking' ? (
          <div className="cag-item-thinking-content">
            <XAilyThinkViewer content={part.content || ''} isComplete={part.isComplete === true} embedded />
          </div>
        ) : (
          <>
            <button
              type="button"
              className={`cag-item-summary ${hasDetail ? 'cag-item-summary-clickable' : ''}`}
              aria-expanded={hasDetail ? detailExpanded : undefined}
              disabled={!hasDetail}
              onClick={() => hasDetail && setDetailExpanded(value => !value)}
            >
              {partType === 'tool' ? (
                <span className="cag-item-tool-title">
                  <span className="cag-item-tool-title-main">
                    <span className="cag-item-tool-title-label">{getToolTitle(part)}</span>
                    {getToolSubtitle(part) && <small className="cag-item-tool-title-subtitle">{getToolSubtitle(part)}</small>}
                  </span>
                  <span className="cag-item-tool-title-side">
                    {part.displayMeta && <span className="cag-item-head-meta">{part.displayMeta}</span>}
                    {getToolStatus(part) && (
                      <span className="cag-item-pill" data-tone={part.displayTone || getStateTone(resolvePartState(part, partType))}>
                        {getToolStatus(part)}
                      </span>
                    )}
                    {hasDetail && (
                      <span className="cag-item-chevron-wrap" aria-hidden="true">
                        <FaIcon icon="chevron-down" className={`cag-item-chevron ${detailExpanded ? 'cag-item-chevron-expanded' : ''}`} />
                      </span>
                    )}
                  </span>
                </span>
              ) : (
                <>
                  <span className="cag-item-summary-label">{part.title || activityTitle(partType)}</span>
                  {hasDetail && (
                    <span className="cag-item-chevron-wrap" aria-hidden="true">
                      <FaIcon icon="chevron-down" className={`cag-item-chevron ${detailExpanded ? 'cag-item-chevron-expanded' : ''}`} />
                    </span>
                  )}
                </>
              )}
            </button>
            {hasDetail && detailExpanded && (
              <div className="cag-item-detail">
                {detailRenderReady
                  ? renderActivityBody(partType, part)
                  : <div className="cag-item-detail-loading" aria-hidden="true" />}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});

function updateDetailViewportFades(
  viewport: HTMLElement,
  setShowTopFade: (value: boolean) => void,
  setShowBottomFade: (value: boolean) => void,
): void {
  const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  setShowTopFade(maxScrollTop > 0 && viewport.scrollTop > 5);
  setShowBottomFade(maxScrollTop > 0 && viewport.scrollTop < maxScrollTop - 5);
}

function normalizeType(type?: ChatPart['type']): string {
  return type === 'tool_call' ? 'tool' : type || 'state';
}

function getActivityGroupState(parts: ChatPart[]): 'doing' | 'done' | 'error' {
  const toolStates = parts
    .filter(part => part.type === 'tool_call' || part.type === 'tool' || part.type === 'confirmation' || part.type === 'terminal')
    .map(part => resolvePartState(part, normalizeType(part.type)));
  const stateStates = parts
    .filter(part => part.type === 'state')
    .map(part => resolvePartState(part, 'state'));
  const hasIncompleteThinking = parts.some(part => part.type === 'thinking' && part.isComplete !== true);

  if (toolStates.includes('error') || stateStates.includes('error')) {
    return 'error';
  }
  if (toolStates.includes('doing') || toolStates.includes('pending_approval') || stateStates.includes('doing') || hasIncompleteThinking) {
    return 'doing';
  }
  return 'done';
}

function resolvePartState(part: ChatPart, partType: string): PartState | string {
  if (partType === 'confirmation') {
    return part.resolved === true ? 'done' : 'pending_approval';
  }
  if (partType === 'terminal') {
    if (part.isRunning === true) return 'doing';
    return part.exitCode != null && part.exitCode !== 0 ? 'error' : 'done';
  }
  if (partType === 'tool') {
    const state = part.state;
    if (state === 'doing' || state === 'done' || state === 'error' || state === 'warn' || state === 'pending_approval') {
      return state;
    }
    return 'done';
  }
  if (partType === 'state') {
    return part.state || 'done';
  }
  if (partType === 'thinking') {
    return part.isComplete === true ? 'done' : 'doing';
  }
  return part.state || 'done';
}

function hasDetailContent(part: ChatPart, partType: string): boolean {
  if (partType === 'thinking') return false;
  if (partType === 'tool') {
    return part.args !== undefined || !!part.output || !!part.content || !!part.detail || !!part.text;
  }
  if (partType === 'terminal') return !!part.output || !!part.content || !!part.command;
  if (partType === 'state') return !!part.text || !!part.detail || !!part.content;
  if (partType === 'confirmation') return !!part.text || !!part.detail;
  return !!part.content || !!part.detail || !!part.text;
}

function groupHeader(parts: ChatPart[]): { title: string; detail: string } {
  const first = parts[0];
  const last = parts[parts.length - 1];
  const firstType = normalizeType(first?.type);
  if (firstType === 'thinking') {
    return {
      title: first?.isComplete === false ? t('THINKING', '思考中') : t('THOUGHT', '思考'),
      detail: parts.length > 1 ? getPartSummary(last) : '',
    };
  }
  if (firstType === 'tool') {
    return {
      title: getToolTitle(first),
      detail: parts.length > 1
        ? t('ACTIVITY_ITEMS', '{{count}} 项活动').replace('{{count}}', String(parts.length))
        : '',
    };
  }
  return {
    title: first?.title || activityTitle(firstType),
    detail: String(last?.detail || last?.text || ''),
  };
}

function getPartSummary(part?: ChatPart): string {
  if (!part) return '';
  return normalizeType(part.type) === 'tool'
    ? [getToolTitle(part), getToolSubtitle(part)].filter(Boolean).join(' · ')
    : String(part.title || part.text || part.detail || '');
}

function getToolTitle(part?: ChatPart): string {
  if (!part) return t('TOOL_CALL', '工具');
  return part.toolDisplayName
    || formatPascalCase(part.toolName)
    || part.displayTitle
    || part.title
    || t('TOOL_CALL', '工具');
}

function getToolSubtitle(part?: ChatPart): string {
  if (!part) return '';
  return [
    part.displayTitle && part.displayTitle !== getToolTitle(part) ? part.displayTitle : '',
  ].filter(Boolean).join(' · ');
}

function formatPascalCase(value?: string): string {
  return String(value || '')
    .replace(/^mcp_/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(token => token.charAt(0).toUpperCase() + token.slice(1))
    .join('');
}

function getToolStatus(part: ChatPart): string {
  if (part.displayStatus) return part.displayStatus;
  switch (resolvePartState(part, 'tool')) {
    case 'error': return t('STATUS_FAILED', '失败');
    case 'warn': return t('STATUS_WARNING', '警告');
    case 'pending_approval': return t('STATUS_PENDING_APPROVAL', '待审批');
    default: return '';
  }
}

function getStateTone(state: string): string {
  switch (state) {
    case 'done': return 'success';
    case 'error': return 'error';
    case 'warn':
    case 'pending_approval': return 'warn';
    case 'doing':
    case 'info': return 'info';
    default: return 'neutral';
  }
}

function getToolIconClass(state?: PartState | string): string {
  switch (state) {
    case 'done':
      return 'fa-light fa-circle-check';
    case 'error':
      return 'fa-light fa-circle-exclamation';
    case 'warn':
      return 'fa-light fa-triangle-exclamation';
    case 'pending_approval':
      return 'fa-light fa-circle-pause';
    default:
      return 'fa-light fa-spinner-third';
  }
}

function getStateIconClass(state?: PartState | string): string {
  switch (state) {
    case 'done':
      return 'fa-light fa-circle-check';
    case 'error':
      return 'fa-light fa-circle-exclamation';
    case 'warn':
      return 'fa-light fa-triangle-exclamation';
    case 'info':
      return 'fa-light fa-circle-info';
    default:
      return 'fa-light fa-spinner-third';
  }
}

function getStateColor(state?: PartState | string): string {
  switch (state) {
    case 'done':
      return 'var(--chat-success, #89d185)';
    case 'error':
      return 'var(--chat-error, #f14c4c)';
    case 'warn':
      return 'var(--chat-warn, #cca700)';
    case 'info':
    case 'doing':
      return 'var(--chat-info, #75beff)';
    case 'pending_approval':
      return 'var(--chat-warn, #cca700)';
    default:
      return 'var(--chat-fg-muted, #6a6a6a)';
  }
}

function getPartIconPresentation(part: ChatPart, partType: string): PartIconPresentation {
  if (partType === 'thinking') {
    const spinning = part.isComplete !== true;
    return {
      iconClass: spinning ? 'fa-light fa-spinner-third cag-spin' : 'fa-light fa-circle-check',
      spin: false,
      color: spinning ? 'var(--chat-info, #75beff)' : 'var(--chat-success, #89d185)',
      shellLoading: false,
    };
  }

  const state = resolvePartState(part, partType);
  const spinning = state === 'doing' || state === 'pending_approval';

  if (partType === 'terminal') {
    const failed = !spinning && part.exitCode != null && part.exitCode !== 0;
    return {
      iconClass: spinning ? 'fa-light fa-spinner-third' : failed ? 'fa-light fa-circle-xmark' : 'fa-light fa-circle-check',
      spin: false,
      color: failed ? 'var(--chat-error, #f14c4c)' : spinning ? 'var(--chat-info, #75beff)' : 'var(--chat-success, #89d185)',
      shellLoading: spinning,
    };
  }

  if (partType === 'tool') {
    return {
      iconClass: getToolIconClass(state),
      spin: false,
      color: getStateColor(state),
      shellLoading: spinning,
    };
  }

  if (partType === 'confirmation') {
    return {
      iconClass: state === 'pending_approval'
        ? 'fa-light fa-circle-pause'
        : state === 'warn'
          ? 'fa-light fa-circle-minus'
          : 'fa-light fa-circle-check',
      spin: false,
      color: getStateColor(state),
      shellLoading: false,
    };
  }

  return {
    iconClass: getStateIconClass(state),
    spin: false,
    color: getStateColor(state),
    shellLoading: state === 'doing',
  };
}

function activityTitle(type: string): string {
  if (type === 'thinking') return t('THINKING', '思考');
  if (type === 'terminal') return t('TERMINAL', '终端');
  if (type === 'tool') return t('TOOL_CALL', '工具调用');
  return t('STATE', '状态');
}

function renderActivityBody(type: string, part: ChatPart) {
  if (type === 'terminal') return <XAilyTerminalViewer part={part} />;
  if (type === 'state') return <XAilyStateViewer part={part} />;
  if (type === 'confirmation') return <XAilyConfirmationViewer part={part} />;
  return <XAilyToolViewer part={part} />;
}
