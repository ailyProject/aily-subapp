import {
  FormEvent,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  bootstrap,
  ChatMenuOption,
  ChatSession,
  ChatTodo,
  ChatTurn,
  invoke,
  loadDraft,
  saveDraft,
  t,
  useChatState,
} from './protocol';
import { AilyChatSettings } from './components/settings/AilyChatSettings';
import { Icon, FaIcon } from './components/shared/Icon';
import { XDialog } from './components/x-dialog/XDialog';

type MenuKind = 'mode' | 'permission' | 'model' | 'session';

interface OpenMenuState {
  kind: MenuKind;
  anchor: DOMRect;
}

const SessionRow = memo(function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: ChatSession;
  selected: boolean;
  onSelect(id: string): void;
}) {
  return (
    <div className="session-list-row" data-selected={selected} data-current={session.current}>
      <button className="session-list-item" onClick={() => onSelect(session.id)}>
        <span className="session-list-activity-indicator">
          {session.status === 'running'
            ? <FaIcon icon="spinner-third" spin className="session-spinner" />
            : session.unread ? <span className="session-list-unread-dot" /> : null}
        </span>
        <span className="session-list-copy">
          <span className="session-list-item-title">{session.title}</span>
          {(session.detail?.length || session.status) && (
            <span className="session-list-item-meta-row">
              {session.detail?.map(detail => <span key={detail}>{detail}</span>)}
              {session.status && <span className={`status-${session.status}`}>{session.status}</span>}
            </span>
          )}
        </span>
      </button>
      <div className="session-list-actions">
        <button title={t('SESSION_MORE', '更多')}>•••</button>
      </div>
    </div>
  );
});

function SessionList({
  sessions,
  activeSessionId,
  onSelect,
}: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  onSelect(id: string): void;
}) {
  const groups = useMemo(() => {
    const pinned = sessions.filter(item => item.pinned);
    const active = sessions.filter(item => !item.pinned && !item.archived);
    const archived = sessions.filter(item => item.archived);
    return [
      pinned.length ? { id: 'pinned', label: t('PINNED', '已固定'), items: pinned } : null,
      { id: 'recent', label: t('SESSIONS', 'Sessions'), items: active },
      archived.length ? { id: 'archived', label: t('ARCHIVED', '已归档'), items: archived } : null,
    ].filter(Boolean) as Array<{ id: string; label: string; items: ChatSession[] }>;
  }, [sessions]);

  return (
    <section className="session-list-panel">
      <header className="session-list-header">
        <span className="session-list-title">{t('SESSIONS', 'Sessions')}</span>
      </header>
      <div className="session-list-body">
        <div className="session-list-items">
          {groups.map(group => (
            <section key={group.id} className="session-group">
              <div className="session-list-section-label">{group.label}</div>
              {group.items.map(session => (
                <SessionRow
                  key={session.id}
                  session={session}
                  selected={session.id === activeSessionId}
                  onSelect={onSelect}
                />
              ))}
            </section>
          ))}
          {!sessions.length && <div className="session-list-empty">{t('NO_SESSIONS', '暂无会话')}</div>}
        </div>
      </div>
    </section>
  );
}

function TodoWidget({ todos }: { todos: ChatTodo[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!todos.length) return null;
  const completed = todos.filter(todo => todo.status === 'completed').length;
  return (
    <section className="chat-todo-list-widget">
      <header className="todo-list-expand">
        <button className="todo-list-toggle" onClick={() => setCollapsed(value => !value)}>
          <FaIcon icon="chevron-right" className="expand-icon" data-expanded={!collapsed} />
          <FaIcon icon="circle-check" className="todo-header-status" />
          <span>{t('TODO_PROGRESS', '任务')} {completed}/{todos.length}</span>
        </button>
        <button className="todo-clear-button" title={t('CLEAR', '清空')} onClick={() => void invoke('todo.clear')}><FaIcon icon="trash" /></button>
      </header>
      {!collapsed && (
        <div className="todo-list-container">
          {todos.map(todo => (
            <button className="todo-item" data-status={todo.status} key={todo.id} onClick={() => void invoke('todo.toggle', { id: todo.id })}>
              <FaIcon
                className="todo-status-icon"
                icon={todo.status === 'completed' ? 'circle-check' : todo.status === 'in-progress' ? 'circle-pause' : 'circle'}
              />
              <span>{todo.content}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function EditTurnBox({ turn, onClose }: { turn: ChatTurn; onClose(): void }) {
  const [value, setValue] = useState(() => turn.parts.map(part => part.content || part.text || '').join('\n'));

  async function submit(): Promise<void> {
    const text = value.trim();
    if (!text) return;
    await invoke('turn.edit', { turnId: turn.id, text });
    onClose();
  }

  return (
    <section className="edit-input-box">
      <textarea
        autoFocus
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape') onClose();
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
      />
      <footer>
        <button title={t('CANCEL', '取消')} onClick={onClose}><FaIcon icon="xmark" /></button>
        <button title={t('SEND', '发送')} onClick={() => void submit()}><FaIcon icon="paper-plane" /></button>
      </footer>
    </section>
  );
}

function PopupMenu({
  title,
  options,
  anchor,
  placement,
  onSelect,
  onClose,
}: {
  title: string;
  options: ChatMenuOption[];
  anchor: DOMRect;
  placement: 'above' | 'below';
  onSelect(option: ChatMenuOption): void;
  onClose(): void;
}) {
  const menuWidth = Math.min(300, window.innerWidth - 16);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menuWidth - 8));
  const style = placement === 'below'
    ? { left, top: Math.min(window.innerHeight - 80, anchor.bottom + 4), width: menuWidth }
    : { left, bottom: Math.max(8, window.innerHeight - anchor.top + 4), width: menuWidth };

  return (
    <>
      <button className="menu-backdrop" aria-label={t('CLOSE', '关闭')} onClick={onClose} />
      <section className="popup-menu" style={style}>
        <header>{title}</header>
        <div className="popup-menu-list">
          {options.map(option => (
            <button key={option.id} disabled={option.disabled} data-active={option.active} onClick={() => onSelect(option)}>
              <Icon icon={option.active ? 'circle-check' : 'circle'} />
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
              {option.billingLabel && <em>{option.billingLabel}</em>}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

export default function App() {
  const chat = useChatState();
  const [draft, setDraft] = useState(() => loadDraft() || chat.inputValue || '');
  const [menu, setMenu] = useState<OpenMenuState | null>(null);
  const [editingTurn, setEditingTurn] = useState<ChatTurn | null>(null);
  const [todoFocused, setTodoFocused] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const hostInputHydratedRef = useRef(false);

  useEffect(() => { void bootstrap(); }, []);
  useEffect(() => {
    if (chat.loading || hostInputHydratedRef.current) return;
    hostInputHydratedRef.current = true;
    if (!draft && chat.inputValue) setDraft(chat.inputValue);
  }, [chat.loading, chat.inputValue, draft]);
  useEffect(() => saveDraft(draft), [draft]);
  useEffect(() => {
    if (chat.runState === 'running') {
      timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight });
    }
  }, [chat.turns, chat.runState]);

  async function selectSession(sessionId: string): Promise<void> {
    await invoke('session.select', { sessionId });
    setMenu(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function submit(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    saveDraft('');
    if (composerRef.current) {
      composerRef.current.value = '';
    }
    try {
      await invoke('turn.send', {
        sessionId: chat.activeSessionId,
        text,
        modeId: chat.modeId,
        modelId: chat.activeModelId,
        permissionMode: chat.permissionMode,
      });
    } catch {
      setDraft(text);
      saveDraft(text);
    }
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  function toggleMenu(kind: MenuKind, event: ReactMouseEvent<HTMLElement>): void {
    const anchor = event.currentTarget.getBoundingClientRect();
    setMenu(current => current?.kind === kind ? null : { kind, anchor });
  }

  const sessionList = (
    <SessionList sessions={chat.sessions} activeSessionId={chat.activeSessionId} onSelect={selectSession} />
  );
  const showSidebar = chat.sessionListMode === 'sidebar';
  const showConversation = chat.paneSurface === 'chat';

  return (
    <main className="aily-chat-wrapper">
      <div className="window-box">
        <div className={`chat-main-layout ${showSidebar ? 'has-session-sidebar' : ''}`}>
          {showSidebar && (
            <aside className="chat-session-sidebar" style={{ width: chat.sessionSidebarWidth || 280 }}>
              {sessionList}
              <div className="chat-session-sidebar-resize-handle" />
            </aside>
          )}
          <section className="chat-stage">
            <header className="chat-pane-header">
              <div className="session-title-control">
                <button className="session-title-navigation-action" onClick={() => void invoke('surface.back')}><FaIcon icon="chevron-left" /></button>
                <button className="session-title-picker" onClick={event => toggleMenu('session', event)}>
                  <span>{chat.title || chat.sessions.find(item => item.id === chat.activeSessionId)?.title || t('TITLE', 'Aily Chat')}</span>
                  <FaIcon icon="chevron-down" />
                </button>
              </div>
              <div className="host-header-actions">
                <button title={t('NEW_CHAT', '新建会话')} onClick={() => void invoke('session.create')}><FaIcon icon="plus" /></button>
                <button title={t('SETTINGS', '设置')} onClick={() => void invoke('surface.toggleSettings')}><FaIcon icon="gear" /></button>
              </div>
            </header>

            <div className={`dialog-list ${showConversation ? 'has-conversation' : ''}`} ref={timelineRef}>
              {showConversation ? (
                <div className="dialogs">
                  {chat.turns.map(turn => <XDialog key={turn.id} turn={turn} onEdit={setEditingTurn} />)}
                  {!chat.turns.length && <div className="dialog-empty">{t('EMPTY_CHAT', '开始一段新对话')}</div>}
                </div>
              ) : (
                <div className="entry-surface">
                  <section className="guide-box">
                    <FaIcon icon="star-christmas" className="guide-icon" />
                    <div className="title">{t('TITLE', 'Aily Chat')}</div>
                    <div className="text">{t('WELCOME_BODY', 'Aily 可能会犯错，请检查生成内容。')}</div>
                    <button className="link">{t('USAGE_GUIDE', '使用指南')}</button>
                  </section>
                  {chat.sessionListMode === 'stacked' && <div className="stacked-session-list">{sessionList}</div>}
                </div>
              )}
            </div>

            {chat.showSettings ? (
              <AilyChatSettings value={chat.settings} onClose={() => void invoke('surface.toggleSettings')} />
            ) : (
              <footer className="sender">
                <div className="s-box">
                  {chat.notices?.map(notice => (
                    <section className={`chat-input-notification severity-${notice.severity || 'info'}`} key={notice.id}>
                      <strong>{notice.title}</strong><span>{notice.description}</span>
                    </section>
                  ))}
                  <TodoWidget todos={chat.todos || []} />
                  {editingTurn && (
                    <EditTurnBox turn={editingTurn} onClose={() => setEditingTurn(null)} />
                  )}
                  <form className="input-box" data-working={chat.runState === 'running'} onSubmit={submit}>
                    {!!chat.resources?.length && (
                      <div className="resource-list">
                        {chat.resources.map((resource, index) => (
                          <div className="resource-item" key={`${resource.type}-${resource.name}-${index}`}>
                            <Icon icon={resource.type === 'folder' ? 'folder' : resource.type === 'url' ? 'link' : resource.type === 'block' ? 'cube' : 'file'} />
                            <span>{resource.name}</span>
                            <button type="button" onClick={() => void invoke('resource.remove', { index })}><FaIcon icon="xmark" /></button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="textarea-wrapper">
                      <textarea
                        ref={composerRef}
                        data-chat-composer
                        value={draft}
                        maxLength={200_000}
                        placeholder={t('PLACEHOLDER', '询问 Aily…')}
                        onFocus={() => setTodoFocused(true)}
                        onBlur={() => setTodoFocused(false)}
                        onChange={event => setDraft(event.target.value)}
                        onKeyDown={handleComposerKey}
                      />
                    </div>
                    <div className="btns" data-focused={todoFocused}>
                      <div className="composer-context-actions">
                        <button type="button" className="toolbar-button icon-only" title={t('ATTACH', '添加上下文')} onClick={() => void invoke('resource.addFile')}><FaIcon icon="file-circle-plus" /></button>
                        <button type="button" className="toolbar-chip" onClick={event => toggleMenu('mode', event)}><FaIcon icon="user-astronaut" /> <span>{chat.modeLabel || '代理'}</span></button>
                        <button type="button" className="toolbar-chip permission-mode-indicator" onClick={event => toggleMenu('permission', event)}><FaIcon icon="shield-exclamation" /> <span>{chat.permissionLabel || t('PERMISSION_DEFAULT', '默认权限')}</span></button>
                        {chat.contextUsage && <button type="button" className={`token-budget-indicator severity-${chat.contextUsage.severity || 'normal'}`} title={chat.contextUsage.label}><span className="context-ring">{Math.round(chat.contextUsage.percentage)}</span>{chat.contextUsage.estimated && <em>est</em>}</button>}
                        {chat.interactionBudget?.label && <button type="button" className="quota-indicator"><FaIcon icon="hourglass-clock" /> <em>{chat.interactionBudget.label}</em></button>}
                        {chat.authQuota?.label && <button type="button" className="quota-indicator"><FaIcon icon="id-card" /> <em>{chat.authQuota.label}</em></button>}
                        {chat.requestQuota?.label && <button type="button" className="quota-indicator"><FaIcon icon="triangle-exclamation" /> <em>{chat.requestQuota.label}</em></button>}
                      </div>
                      <div className="composer-primary-actions">
                        <button type="button" className="composer-model-chip" onClick={event => toggleMenu('model', event)}><FaIcon icon="star-christmas" /> <span>{chat.modelOptions?.find(option => option.id === chat.activeModelId)?.label || chat.models.find(model => model.id === chat.activeModelId)?.label || chat.activeModelId}</span></button>
                        {chat.runState === 'running'
                          ? <button type="button" className="primary-action stop-action" onClick={() => void invoke('turn.stop', { sessionId: chat.activeSessionId })}><FaIcon icon="stop" /></button>
                          : <button className="primary-action send-action" disabled={!draft.trim()}><FaIcon icon="paper-plane" /></button>}
                      </div>
                    </div>
                  </form>
                </div>
              </footer>
            )}
          </section>
        </div>

        {menu?.kind === 'session' && <PopupMenu title={t('SESSIONS', 'Sessions')} anchor={menu.anchor} placement="below" options={chat.sessions.map(item => ({ id: item.id, label: item.title, active: item.id === chat.activeSessionId }))} onSelect={option => void selectSession(option.id)} onClose={() => setMenu(null)} />}
        {menu?.kind === 'mode' && <PopupMenu title={t('MODE', '模式')} anchor={menu.anchor} placement="above" options={chat.modeOptions || []} onSelect={option => { void invoke('settings.update', { modeId: option.id }); setMenu(null); }} onClose={() => setMenu(null)} />}
        {menu?.kind === 'permission' && <PopupMenu title={t('PERMISSION', '权限')} anchor={menu.anchor} placement="above" options={[
          { id: 'default', label: t('PERMISSION_DEFAULT', '默认权限'), active: chat.permissionMode === 'default' },
          { id: 'full', label: t('PERMISSION_FULL', '完全访问权限'), active: chat.permissionMode === 'full' },
        ]} onSelect={option => { void invoke('settings.update', { permissionMode: option.id }); setMenu(null); }} onClose={() => setMenu(null)} />}
        {menu?.kind === 'model' && <PopupMenu title={t('MODEL', '模型')} anchor={menu.anchor} placement="above" options={chat.modelOptions || []} onSelect={option => { void invoke('settings.update', { modelId: option.id }); setMenu(null); }} onClose={() => setMenu(null)} />}
      </div>
    </main>
  );
}
