import { memo } from 'react';
import { ChatTurn, invoke, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import { ChatMessageParts } from './ChatMessageParts';
import './x-dialog.css';

export const XDialog = memo(function XDialog({
  turn,
  onEdit,
}: {
  turn: ChatTurn;
  onEdit(turn: ChatTurn): void;
}) {
  const isUser = turn.role === 'user';
  return (
    <article className={`dialog-box ${isUser ? 'user' : 'aily'}`} data-doing={turn.doing}>
      {isUser && (turn.canRestore || turn.canFork) && (
        <nav className="user-turn-actions">
          {turn.canRestore && <button onClick={() => void invoke('turn.restore', { turnId: turn.id })}><FaIcon icon="rotate-left" /> {t('RESTORE', '还原')}</button>}
          {turn.canFork && <button onClick={() => void invoke('turn.fork', { turnId: turn.id })}><FaIcon icon="code-branch" /></button>}
        </nav>
      )}
      <div className="content" onDoubleClick={() => isUser && turn.canEdit && onEdit(turn)}>
        <ChatMessageParts parts={turn.parts} doing={!isUser && turn.doing === true} />
      </div>
      {turn.doing && <div className="loader" />}
      <footer className="msg-footer">
        {!isUser && !turn.doing && (
          <div className="msg-actions">
            <button title={t('REGENERATE', '重新生成')} onClick={() => void invoke('turn.regenerate', { turnId: turn.id })}><FaIcon icon="rotate-right" /></button>
            <button title={t('COPY', '复制')} onClick={() => void navigator.clipboard?.writeText(turn.parts.map(part => part.content || part.text || '').join('\n'))}><FaIcon icon="copy" /></button>
            <button data-active={turn.feedback === 'helpful'} onClick={() => void invoke('turn.feedback', { turnId: turn.id, vote: 'helpful' })}><FaIcon icon="thumbs-up" /></button>
            <button data-active={turn.feedback === 'unhelpful'} onClick={() => void invoke('turn.feedback', { turnId: turn.id, vote: 'unhelpful' })}><FaIcon icon="thumbs-down" /></button>
          </div>
        )}
        {turn.modelName && <span className="msg-model-label">{turn.modelName}{turn.modelBillingLabel ? ` · ${turn.modelBillingLabel}` : ''}</span>}
      </footer>
    </article>
  );
});
