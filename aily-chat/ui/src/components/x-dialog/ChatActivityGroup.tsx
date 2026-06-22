import { memo, useEffect, useState } from 'react';
import { ChatPart, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import { XAilyStateViewer } from './XAilyStateViewer';
import { XAilyTerminalViewer } from './XAilyTerminalViewer';
import { XAilyThinkViewer } from './XAilyThinkViewer';
import { XAilyToolViewer } from './XAilyToolViewer';
import { XAilyConfirmationViewer } from './XAilyConfirmationViewer';
import './chat-activity-group.css';

export const ChatActivityGroup = memo(function ChatActivityGroup({
  parts,
  doing,
}: {
  parts: ChatPart[];
  doing: boolean;
}) {
  const [expanded, setExpanded] = useState(doing);
  const first = parts[0];
  const type = normalizeType(first?.type);
  const groupState = doing || parts.some(part => part.state === 'doing')
    ? 'doing'
    : parts.some(part => part.state === 'error')
      ? 'error'
      : 'done';
  const header = groupHeader(parts);
  useEffect(() => {
    if (doing) setExpanded(true);
  }, [doing]);
  return (
    <section className={`cag ${expanded ? 'cag-expanded' : ''}`} data-state={groupState} data-type={type}>
      <button className="cag-header" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        <span className={`cag-icon-shell ${groupState === 'doing' ? 'loading-icon' : ''}`}>
          {groupState === 'done'
            ? <FaIcon icon="circle-check" />
            : groupState === 'error'
              ? <FaIcon icon="circle-xmark" />
              : groupState === 'doing'
                ? <FaIcon icon="spinner-third" spin />
                : <FaIcon icon={activityIcon(type)} />}
        </span>
        <span className="cag-group-default-header">
          <span className="cag-title">{header.title}</span>
          {header.detail && <span className={`cag-subtitle ${groupState === 'doing' && !expanded ? 'cag-shimmer' : ''}`}>{header.detail}</span>}
        </span>
        <span className="cag-chevron-wrap"><FaIcon icon="chevron-down" className="cag-chevron" /></span>
      </button>
      {expanded && (
        <div className={`cag-detail-viewport ${groupState === 'doing' ? 'cag-detail-viewport-fixed' : ''}`}>
          <div className="cag-list">
            {parts.map(part => {
              const partType = normalizeType(part.type);
              return (
                <div className="cag-item" data-kind={partType} key={part.id}>
                  <span className={`cag-item-icon-shell ${part.state === 'doing' ? 'spinner' : ''}`}>
                    {part.state === 'doing'
                      ? <FaIcon icon="spinner-third" spin />
                      : <FaIcon icon={activityIcon(partType)} />}
                  </span>
                  <div className="cag-item-body">
                    {partType !== 'thinking' && <div className="cag-item-summary">{part.title || part.toolName || activityTitle(partType)}</div>}
                    {renderActivityBody(partType, part)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
});

function normalizeType(type?: ChatPart['type']): string {
  return type === 'tool_call' ? 'tool' : type || 'state';
}

function groupHeader(parts: ChatPart[]): { title: string; detail: string } {
  const first = parts[0];
  const last = parts[parts.length - 1];
  const firstType = normalizeType(first?.type);
  if (firstType === 'thinking') {
    return {
      title: first?.isComplete === false ? t('THINKING', 'Thinking...') : 'Thought',
      detail: parts.length > 1 ? String(last?.title || last?.toolName || last?.text || '') : '',
    };
  }
  if (firstType === 'tool') {
    return {
      title: first?.title || first?.toolName || t('TOOL_CALL', '工具调用'),
      detail: parts.length > 1 ? `${parts.length} 项活动` : String(first?.detail || first?.text || ''),
    };
  }
  return {
    title: first?.title || activityTitle(firstType),
    detail: String(last?.detail || last?.text || ''),
  };
}

import type { FaLightIconName } from '../../icons/registry';

function activityIcon(type: string): FaLightIconName {
  if (type === 'thinking') return 'star-christmas';
  if (type === 'terminal') return 'terminal';
  if (type === 'tool') return 'cube';
  return 'circle-info';
}

function activityTitle(type: string): string {
  if (type === 'thinking') return t('THINKING', '思考');
  if (type === 'terminal') return t('TERMINAL', '终端');
  if (type === 'tool') return t('TOOL_CALL', '工具调用');
  return t('STATE', '状态');
}

function renderActivityBody(type: string, part: ChatPart) {
  if (type === 'thinking') return <XAilyThinkViewer content={part.content || ''} isComplete={part.isComplete !== false} embedded />;
  if (type === 'terminal') return <XAilyTerminalViewer part={part} />;
  if (type === 'state') return <XAilyStateViewer part={part} />;
  if (type === 'confirmation') return <XAilyConfirmationViewer part={part} />;
  return <XAilyToolViewer part={part} />;
}
