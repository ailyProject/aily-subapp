import { memo, MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import { Bubble } from '@ant-design/x';
import { ChatTurn, invoke, resolveTurnActionId, t, useChatState, type RunState } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import { ChatMessageParts } from './ChatMessageParts';
import { EditContextToolbar } from './EditContextToolbar';
import './x-dialog.scss';

function UserTurnEditBox({
  turn,
  onClose,
  onModeMenu,
  onModelMenu,
}: {
  turn: ChatTurn;
  onClose(): void;
  onModeMenu(event: ReactMouseEvent<HTMLButtonElement>): void;
  onModelMenu(event: ReactMouseEvent<HTMLButtonElement>): void;
}) {
  const chat = useChatState();
  const boxRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(() => turn.parts.map(part => part.content || part.text || '').join('\n'));
  const modelLabel = chat.modelOptions?.find(option => option.id === chat.activeModelId)?.label
    || chat.models.find(model => model.id === chat.activeModelId)?.label
    || chat.activeModelId;

  useEffect(() => {
    const frameId = window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const length = textarea.value.length;
      textarea.focus();
      textarea.setSelectionRange(length, length);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (boxRef.current?.contains(target)) return;
      if ((target as Element).closest?.('.popup-menu, .popup-submenu, .menu-backdrop')) return;
      onClose();
    }

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [onClose]);

  async function submit(): Promise<void> {
    const text = value.trim();
    if (!text) return;
    await invoke('turn.edit', { turnId: resolveTurnActionId(turn), text });
    onClose();
  }

  return (
    <section className="edit-input-box" ref={boxRef} onClick={event => event.stopPropagation()}>
      <div className="edit-textarea-wrapper">
        <textarea
          ref={textareaRef}
          className="sscroll"
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </div>
      <div className="edit-btns">
        <EditContextToolbar
          modeId={chat.modeId || 'agent'}
          modeLabel={
            chat.modeId === 'plan'
              ? t('MODE_PLAN', '计划')
              : chat.modeId === 'ask'
                ? t('MODE_DOCUMENT', '文档')
                : chat.modeId === 'edit'
                  ? t('MODE_EDIT', '编辑')
                  : chat.modeLabel || t('MODE_AGENT', '代理')
          }
          modelLabel={modelLabel}
          showModelChip={!!modelLabel}
          onModeClick={onModeMenu}
          onModelClick={onModelMenu}
          onAddFile={() => void invoke('resource.addFile')}
          onAddFolder={() => void invoke('resource.addFolder')}
        />
        <button type="button" className="edit-btn edit-cancel-btn" title={`${t('CANCEL', '取消')} (Esc)`} onClick={onClose}>
          <FaIcon icon="xmark" />
        </button>
        <button type="button" className="edit-btn edit-send-btn" title={`${t('SEND', '发送')} (Enter)`} onClick={() => void submit()}>
          <FaIcon icon="paper-plane" />
        </button>
      </div>
    </section>
  );
}

export const XDialog = memo(function XDialog({
  turn,
  streamingActive = false,
  runState = 'idle',
  isLastAily = false,
  editingTurnId = null,
  onEditStart,
  onEditClose,
  onEditModeMenu,
  onEditModelMenu,
}: {
  turn: ChatTurn;
  streamingActive?: boolean;
  runState?: RunState;
  isLastAily?: boolean;
  editingTurnId?: string | null;
  onEditStart?(turn: ChatTurn): void;
  onEditClose?(): void;
  onEditModeMenu?(event: ReactMouseEvent<HTMLButtonElement>): void;
  onEditModelMenu?(event: ReactMouseEvent<HTMLButtonElement>): void;
}) {
  const isUser = turn.role === 'user';
  const isEditing = isUser && editingTurnId === turn.id;
  const canEdit = isUser && turn.canEdit === true && runState === 'idle' && turn.doing !== true;
  const doing = !isUser && (turn.doing === true || streamingActive);
  const editTooltip = canEdit && !isEditing ? t('CLICK_TO_EDIT', '点击编辑') : '';
  const canShowActions = !isUser && isLastAily && !doing;
  const canShowLimitActions = !isUser && (!isLastAily || !doing);
  const shouldRenderFooter = canShowActions || canShowLimitActions;
  const showAssistantModelBadge = shouldRenderFooter && !isUser && !!turn.modelName;

  const footer = shouldRenderFooter ? (
    <footer className="msg-footer">
      {(canShowActions || canShowLimitActions) && (
        <div className="msg-actions">
          {canShowActions && (
            <button disabled={doing} title={t('REGENERATE', '重新生成')} onClick={() => void invoke('turn.regenerate', { turnId: resolveTurnActionId(turn) })}>
              <FaIcon icon="rotate-right" />
            </button>
          )}
          <button title={t('COPY', '复制')} onClick={() => void navigator.clipboard?.writeText(turn.parts.map(part => part.content || part.text || '').join('\n'))}>
            <FaIcon icon="copy" />
          </button>
          <button data-active={turn.feedback === 'helpful'} onClick={() => void invoke('turn.feedback', { turnId: resolveTurnActionId(turn), vote: 'helpful' })}>
            <FaIcon icon="thumbs-up" />
          </button>
          <button data-active={turn.feedback === 'unhelpful'} onClick={() => void invoke('turn.feedback', { turnId: resolveTurnActionId(turn), vote: 'unhelpful' })}>
            <FaIcon icon="thumbs-down" />
          </button>
        </div>
      )}
      {showAssistantModelBadge && (
        <span className="msg-model-label">
          {turn.modelName}{turn.modelBillingLabel ? ` · ${turn.modelBillingLabel}` : ''}
        </span>
      )}
    </footer>
  ) : undefined;

  if (isEditing) {
    return (
      <article className="dialog-box user is-editing">
        <UserTurnEditBox
          turn={turn}
          onClose={() => onEditClose?.()}
          onModeMenu={event => onEditModeMenu?.(event)}
          onModelMenu={event => onEditModelMenu?.(event)}
        />
      </article>
    );
  }

  return (
    <article
      className={[
        'dialog-box',
        isUser ? 'user' : 'aily',
        canEdit ? 'editable' : '',
        isUser && (turn.canRestore || turn.canFork) ? 'has-turn-actions' : '',
        shouldRenderFooter ? 'has-hover-footer' : '',
      ].filter(Boolean).join(' ')}
      data-doing={doing}
    >
      {isUser && (turn.canRestore || turn.canFork) && (
        <nav className="user-turn-actions">
          {turn.canRestore && (
            <button onClick={() => void invoke('turn.restore', { turnId: resolveTurnActionId(turn) })}>
              <FaIcon icon="rotate-left" /> {t('RESTORE', '还原')}
            </button>
          )}
          {turn.canFork && (
            <button onClick={() => void invoke('turn.fork', { turnId: resolveTurnActionId(turn) })}>
              <FaIcon icon="code-branch" />
            </button>
          )}
        </nav>
      )}
      <Bubble
        rootClassName="aily-x-bubble"
        placement={isUser ? 'end' : 'start'}
        variant={isUser ? 'filled' : 'borderless'}
        shape={isUser ? 'corner' : 'default'}
        streaming={doing}
        footer={footer}
        footerPlacement={isUser ? 'outer-end' : 'outer-start'}
        content={(
          <div
            className="content"
            title={editTooltip}
            onClick={() => {
              if (canEdit) onEditStart?.(turn);
            }}
          >
            <ChatMessageParts parts={turn.parts} doing={doing} />
            {doing && <div className="loader" />}
          </div>
        )}
      />
    </article>
  );
});
