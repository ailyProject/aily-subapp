import {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Sender, XProvider } from '@ant-design/x';
import type { SenderRef } from '@ant-design/x/es/sender';
import { theme as antdTheme } from 'antd';
import {
  bootstrap,
  ChatMenuOption,
  ChatTodo,
  invoke,
  loadDraft,
  menuOptionOpensSettings,
  saveDraft,
  stopTurn,
  t,
  useChatState,
} from './protocol';
import { AilyChatSettings } from './components/settings/AilyChatSettings';
import { SessionList } from './components/session/SessionList';
import { RuntimeConfirmationCarousel } from './components/runtime/RuntimeConfirmationCarousel';
import { RuntimeQuestionCarousel } from './components/runtime/RuntimeQuestionCarousel';
import { RuntimePlanReviewCarousel } from './components/runtime/RuntimePlanReviewCarousel';
import { FaIcon, resourceIcon } from './components/shared/Icon';
import { XDialog } from './components/x-dialog/XDialog';

type MenuKind = 'mode' | 'permission' | 'model' | 'session';

interface OpenMenuState {
  kind: MenuKind;
  anchor: DOMRect;
}

const DIALOG_AUTO_SCROLL_THRESHOLD_PX = 30;
const CONTEXT_TOOLBAR_COLLAPSE_DELAY_MS = 140;

function TodoWidget({ todos }: { todos: ChatTodo[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (!todos.length) return null;
  const completed = todos.filter(todo => todo.status === 'completed').length;
  return (
    <section className="chat-todo-list-widget">
      <header className="todo-list-expand">
        <button className="todo-list-toggle" onClick={() => setCollapsed(value => !value)}>
          <FaIcon icon="chevron-right" className="expand-icon" data-expanded={!collapsed} />
          <FaIcon icon="list-check" className="todo-header-status" />
          <span>{t('TODO_PROGRESS', '任务')} {completed}/{todos.length}</span>
        </button>
        <button className="todo-clear-button" title={t('CLEAR', '清空')} onClick={() => void invoke('todo.clear')}>
          <FaIcon icon="broom-wide" />
        </button>
      </header>
      {!collapsed && (
        <div className="todo-list-container">
          {todos.map(todo => (
            <button className="todo-item" data-status={todo.status} key={todo.id} onClick={() => void invoke('todo.toggle', { id: todo.id })}>
              <FaIcon
                icon={todo.status === 'completed' ? 'circle-check' : todo.status === 'in-progress' ? 'circle-dot' : 'circle'}
                className="todo-status-icon"
                spin={todo.status === 'in-progress'}
              />
              <span>{todo.content}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function PopupMenu({
  options,
  anchor,
  placement,
  kind,
  onSelect,
  onClose,
}: {
  options: ChatMenuOption[];
  anchor: DOMRect;
  placement: 'above' | 'below';
  kind: MenuKind;
  onSelect(option: ChatMenuOption): void;
  onClose(): void;
}) {
  const [filter, setFilter] = useState('');
  const [activeSubmenu, setActiveSubmenu] = useState<ChatMenuOption | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLElement>(null);
  const submenuRef = useRef<HTMLElement>(null);
  const preferredWidth = kind === 'permission' ? 168 : kind === 'mode' ? 250 : kind === 'model' ? 260 : 260;
  const menuWidth = Math.min(preferredWidth, window.innerWidth - 16);
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menuWidth - 8));
  const style = (placement === 'below'
    ? { left, top: Math.min(window.innerHeight - 80, anchor.bottom + 4), '--popup-menu-target-width': `${menuWidth}px` }
    : { left, bottom: Math.max(8, window.innerHeight - anchor.top + 4), '--popup-menu-target-width': `${menuWidth}px` }) as CSSProperties & { '--popup-menu-target-width': string };
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visibleOptions = normalizedFilter
    ? options.filter(option => `${option.label} ${option.description || ''}`.toLocaleLowerCase().includes(normalizedFilter))
    : options;

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || submenuRef.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('click', closeOnOutsideClick, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('click', closeOnOutsideClick, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [onClose]);

  function openSubmenu(option: ChatMenuOption, target: HTMLButtonElement): void {
    if (!option.children?.length) {
      setActiveSubmenu(null);
      setSubmenuPosition(null);
      return;
    }
    const rowRect = target.getBoundingClientRect();
    const menuRect = target.closest('.popup-menu')?.getBoundingClientRect() ?? rowRect;
    const submenuWidth = 280;
    const gap = 6;
    const rightLeft = menuRect.right + gap;
    const leftLeft = menuRect.left - submenuWidth - gap;
    setActiveSubmenu(option);
    setSubmenuPosition({
      left: rightLeft + submenuWidth <= window.innerWidth - 8
        ? rightLeft
        : Math.max(8, leftLeft),
      top: Math.max(8, Math.min(rowRect.top, window.innerHeight - 220)),
    });
  }

  return (
    <>
      <div className="menu-backdrop" aria-hidden="true" />
      <section className={`popup-menu popup-menu-${kind}`} style={style} ref={menuRef}>
        {kind === 'model' && (
          <label className="popup-menu-filter">
            <FaIcon icon="magnifying-glass" />
            <input
              autoFocus
              value={filter}
              placeholder={t('SEARCH_MODEL', '搜索模型')}
              onChange={event => setFilter(event.target.value)}
            />
          </label>
        )}
        <div className="popup-menu-list">
          {visibleOptions.map(option => option.type === 'section' ? (
            <div className="popup-menu-entry" key={`${option.path?.join('.')}:${option.id}`}>
              {option.separatorBefore && <div className="popup-menu-separator" />}
              <div className="popup-menu-section">{option.label}</div>
            </div>
          ) : (
            <div className="popup-menu-entry" key={`${option.path?.join('.')}:${option.id}`}>
              {option.separatorBefore && <div className="popup-menu-separator" />}
              <button
                disabled={option.disabled}
                data-active={option.active}
                data-submenu-active={activeSubmenu === option}
                title={option.description || option.label}
                onClick={() => onSelect(option)}
                onMouseEnter={event => openSubmenu(option, event.currentTarget)}
                onMouseMove={event => {
                  if (!option.children?.length || activeSubmenu === option) {
                    return;
                  }
                  openSubmenu(option, event.currentTarget);
                }}
              >
                {option.iconClass && <FaIcon iconClass={option.iconClass} />}
                <span className="popup-menu-label"><strong>{option.label}</strong></span>
                {option.billingLabel && <em>{option.billingLabel}</em>}
                {!!option.children?.length && <FaIcon icon="chevron-right" className="popup-menu-arrow" />}
              </button>
            </div>
          ))}
        </div>
      </section>
      {activeSubmenu?.children?.length && submenuPosition && (
        <section className="popup-submenu" style={{ ...submenuPosition, width: 280 }} ref={submenuRef}>
          {activeSubmenu.description && (
            <div className="popup-submenu-description">{activeSubmenu.description}</div>
          )}
          <div className="popup-submenu-list">
            {activeSubmenu.children.map(child => (
              <button
                key={`${child.path?.join('.')}:${child.id}`}
                disabled={child.disabled}
                data-active={child.active}
                title={[child.label, child.detail || child.description].filter(Boolean).join(' - ')}
                onClick={() => onSelect(child)}
              >
                <span className="popup-submenu-copy">
                  <strong>{child.label}</strong>
                  {(child.detail || child.description) && <small>{child.detail || child.description}</small>}
                </span>
                {child.active && <FaIcon icon="circle-check" />}
              </button>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export default function App() {
  const chat = useChatState();
  const [draft, setDraft] = useState(() => loadDraft() || chat.inputValue || '');
  const [menu, setMenu] = useState<OpenMenuState | null>(null);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [contextToolbarVisible, setContextToolbarVisible] = useState(false);
  const [editingTurnId, setEditingTurnId] = useState<string | null>(null);
  const [todoFocused, setTodoFocused] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const windowBoxRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<SenderRef>(null);
  const hostInputHydratedRef = useRef(false);
  const contextCollapseTimerRef = useRef<number | null>(null);
  const dialogAutoScrollEnabledRef = useRef(true);
  const dialogProgrammaticScrollRef = useRef(false);
  const dialogScrollFrameRef = useRef<number | null>(null);
  const dialogScrollSecondFrameRef = useRef<number | null>(null);
  const dialogUserScrollIntentUntilRef = useRef(0);
  const pendingSessionBottomRef = useRef<string | null>(null);
  const [draggingSidebarWidth, setDraggingSidebarWidth] = useState<number | null>(null);

  useEffect(() => {
    setEditingTurnId(null);
    dialogAutoScrollEnabledRef.current = true;
    pendingSessionBottomRef.current = chat.activeSessionId;
  }, [chat.activeSessionId]);

  useEffect(() => {
    if (chat.showSettings) {
      setEditingTurnId(null);
      setMenu(null);
    }
  }, [chat.showSettings]);
  useEffect(() => { void bootstrap(); }, []);
  useEffect(() => {
    return () => {
      if (contextCollapseTimerRef.current !== null) {
        window.clearTimeout(contextCollapseTimerRef.current);
      }
      cancelScheduledDialogScroll(dialogScrollFrameRef, dialogScrollSecondFrameRef);
    };
  }, []);
  useEffect(() => {
    const element = windowBoxRef.current;
    if (!element) {
      return;
    }

    let frameId = 0;
    let lastSentWidth = -1;

    const flushWidth = () => {
      frameId = 0;
      const nextWidth = Math.round(element.clientWidth);
      if (nextWidth === lastSentWidth) {
        return;
      }
      lastSentWidth = nextWidth;
      void invoke('layout.setViewportWidth', { width: nextWidth });
    };

    const scheduleWidthReport = () => {
      if (frameId !== 0) {
        return;
      }
      frameId = window.requestAnimationFrame(flushWidth);
    };

    scheduleWidthReport();

    if (typeof ResizeObserver === 'undefined') {
      const handleResize = () => scheduleWidthReport();
      window.addEventListener('resize', handleResize);
      return () => {
        window.removeEventListener('resize', handleResize);
        if (frameId !== 0) {
          window.cancelAnimationFrame(frameId);
        }
      };
    }

    const observer = new ResizeObserver(() => scheduleWidthReport());
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);
  useEffect(() => {
    if (chat.loading || hostInputHydratedRef.current) return;
    hostInputHydratedRef.current = true;
    if (!draft && chat.inputValue) setDraft(chat.inputValue);
  }, [chat.loading, chat.inputValue, draft]);
  useEffect(() => saveDraft(draft), [draft]);
  useEffect(() => {
    const timeline = timelineRef.current;
    if (chat.runState === 'running' && timeline && dialogAutoScrollEnabledRef.current) {
      scheduleDialogScrollToBottom(timeline);
    }
  }, [chat.turns, chat.runState]);
  useEffect(() => {
    const sessionId = chat.activeSessionId;
    const timeline = timelineRef.current;
    const content = timeline?.querySelector<HTMLElement>('.dialogs');
    if (
      !sessionId
      || pendingSessionBottomRef.current !== sessionId
      || chat.paneSurface === 'session-loading'
      || !timeline
      || !content
    ) {
      return;
    }

    dialogAutoScrollEnabledRef.current = true;
    scheduleDialogScrollToBottom(timeline);

    let frameId = window.requestAnimationFrame(() => scheduleDialogScrollToBottom(timeline));
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => scheduleDialogScrollToBottom(timeline))
      : null;
    observer?.observe(content);

    const settleTimer = window.setTimeout(() => {
      frameId = window.requestAnimationFrame(() => {
        scheduleDialogScrollToBottom(timeline);
        if (pendingSessionBottomRef.current === sessionId) {
          pendingSessionBottomRef.current = null;
        }
        observer?.disconnect();
      });
    }, 300);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(settleTimer);
      observer?.disconnect();
    };
  }, [chat.activeSessionId, chat.paneSurface, chat.turns]);
  useEffect(() => {
    const timeline = timelineRef.current;
    const content = timeline?.querySelector<HTMLElement>('.dialogs');
    if (chat.runState !== 'running' || !timeline || !content || typeof ResizeObserver === 'undefined') {
      return;
    }

    let frameId = 0;
    const observer = new ResizeObserver(() => {
      if (!dialogAutoScrollEnabledRef.current || frameId !== 0) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        if (dialogAutoScrollEnabledRef.current) {
          scheduleDialogScrollToBottom(timeline);
        }
      });
    });
    observer.observe(content);

    return () => {
      observer.disconnect();
      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [chat.activeSessionId, chat.runState]);

  function handleDialogScroll(): void {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }

    const distanceFromBottom = Math.max(
      0,
      timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
    );
    if (distanceFromBottom <= DIALOG_AUTO_SCROLL_THRESHOLD_PX) {
      dialogAutoScrollEnabledRef.current = true;
      return;
    }

    if (dialogProgrammaticScrollRef.current || Date.now() > dialogUserScrollIntentUntilRef.current) {
      return;
    }
    dialogAutoScrollEnabledRef.current = false;
  }

  function markDialogUserScrollIntent(): void {
    dialogUserScrollIntentUntilRef.current = Date.now() + 250;
  }

  function scrollDialogToBottom(timeline: HTMLDivElement): void {
    dialogProgrammaticScrollRef.current = true;
    timeline.scrollTop = timeline.scrollHeight;
    window.requestAnimationFrame(() => {
      if (dialogAutoScrollEnabledRef.current) {
        timeline.scrollTop = timeline.scrollHeight;
      }
      window.requestAnimationFrame(() => {
        dialogProgrammaticScrollRef.current = false;
      });
    });
  }

  function scheduleDialogScrollToBottom(timeline: HTMLDivElement): void {
    if (dialogScrollFrameRef.current !== null) {
      return;
    }

    dialogScrollFrameRef.current = window.requestAnimationFrame(() => {
      dialogScrollFrameRef.current = null;
      if (!dialogAutoScrollEnabledRef.current) {
        return;
      }
      scrollDialogToBottom(timeline);

      if (dialogScrollSecondFrameRef.current !== null) {
        window.cancelAnimationFrame(dialogScrollSecondFrameRef.current);
      }
      dialogScrollSecondFrameRef.current = window.requestAnimationFrame(() => {
        dialogScrollSecondFrameRef.current = null;
        if (dialogAutoScrollEnabledRef.current) {
          scrollDialogToBottom(timeline);
        }
      });
    });
  }

  function cancelScheduledDialogScroll(
    frameRef: { current: number | null },
    secondFrameRef: { current: number | null },
  ): void {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    if (secondFrameRef.current !== null) {
      window.cancelAnimationFrame(secondFrameRef.current);
      secondFrameRef.current = null;
    }
  }

  async function selectSession(sessionId: string): Promise<void> {
    pendingSessionBottomRef.current = sessionId;
    dialogAutoScrollEnabledRef.current = true;
    setMenu(null);
    await invoke<{ switched?: boolean }>('session.select', { sessionId });
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  async function submit(value = draft): Promise<void> {
    const text = value.trim();
    if (!text) return;
    dialogAutoScrollEnabledRef.current = true;
    setDraft('');
    saveDraft('');
    try {
      // turn.send resolves only when the host finishes the turn, so it runs
      // without the default request timeout. The UI updates via snapshots while
      // it is pending; we only restore the draft on a genuine host failure and
      // only if the composer is still empty (user hasn't started a new message).
      await invoke('turn.send', {
        sessionId: chat.activeSessionId,
        text,
        resources: chat.resources || [],
        modeId: chat.modeId,
        modelId: chat.activeModelId,
        permissionMode: chat.permissionMode,
      });
    } catch {
      setDraft(current => {
        if (current) return current;
        saveDraft(text);
        return text;
      });
    }
  }

  function handleMenuSelect(kind: 'mode' | 'model', option: ChatMenuOption): void {
    if (menuOptionOpensSettings(option)) {
      setEditingTurnId(null);
    }
    void invoke('menu.select', { kind, path: option.path || [] });
    setMenu(null);
  }

  function toggleMenu(kind: MenuKind, event: ReactMouseEvent<HTMLElement>): void {
    const anchor = event.currentTarget.getBoundingClientRect();
    setMenu(current => current?.kind === kind ? null : { kind, anchor });
  }

  function permissionIconClass(): string {
    if (chat.permissionPreset === 'full' || chat.permissionMode === 'full') return 'fa-light fa-triangle-exclamation';
    if (chat.permissionPreset === 'auto_review') return 'fa-light fa-robot';
    return 'fa-light fa-shield-check';
  }

  function modeIconClass(): string {
    if (chat.modeId === 'ask') return 'fa-light fa-comment-smile';
    if (chat.modeId === 'plan') return 'fa-light fa-list-check';
    if (chat.modeId === 'edit') return 'fa-light fa-pen-line';
    return 'fa-light fa-user-astronaut';
  }

  function toggleContextToolbar(): void {
    if (contextCollapseTimerRef.current !== null) {
      window.clearTimeout(contextCollapseTimerRef.current);
      contextCollapseTimerRef.current = null;
    }

    setContextExpanded(value => {
      const nextExpanded = !value;
      if (nextExpanded) {
        setContextToolbarVisible(true);
      } else {
        contextCollapseTimerRef.current = window.setTimeout(() => {
          setContextToolbarVisible(false);
          contextCollapseTimerRef.current = null;
        }, CONTEXT_TOOLBAR_COLLAPSE_DELAY_MS);
      }
      return nextExpanded;
    });
  }

  function modeLabel(): string {
    if (chat.modeId === 'plan') return t('MODE_PLAN', '计划');
    if (chat.modeId === 'ask') return t('MODE_DOCUMENT', '文档');
    if (chat.modeId === 'edit') return t('MODE_EDIT', '编辑');
    return chat.modeLabel || t('MODE_AGENT', '代理');
  }

  function clampSidebarWidth(width: number, minWidth: number, maxWidth: number): number {
    return Math.max(minWidth, Math.min(maxWidth, Math.round(width)));
  }

  function handleSessionSidebarResizeStart(event: ReactPointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const minWidth = chat.sessionSidebarResizeMinWidth ?? 240;
    const maxWidth = chat.sessionSidebarMaxWidth ?? Math.max(minWidth, (windowBoxRef.current?.clientWidth ?? 0) - 300);
    const startX = event.clientX;
    const startWidth = draggingSidebarWidth ?? chat.sessionSidebarWidth ?? 300;
    const handle = event.currentTarget;

    handle.setPointerCapture(event.pointerId);

    const handleMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampSidebarWidth(startWidth + (moveEvent.clientX - startX), minWidth, maxWidth);
      setDraggingSidebarWidth(nextWidth);
      void invoke('layout.setSessionSidebarWidth', { width: nextWidth, persist: false });
    };

    const handleUp = (upEvent: PointerEvent) => {
      const nextWidth = clampSidebarWidth(startWidth + (upEvent.clientX - startX), minWidth, maxWidth);
      setDraggingSidebarWidth(null);
      void invoke('layout.setSessionSidebarWidth', { width: nextWidth, persist: true });
      handle.releasePointerCapture(upEvent.pointerId);
      handle.removeEventListener('pointermove', handleMove);
      handle.removeEventListener('pointerup', handleUp);
      handle.removeEventListener('pointercancel', handleUp);
    };

    handle.addEventListener('pointermove', handleMove);
    handle.addEventListener('pointerup', handleUp);
    handle.addEventListener('pointercancel', handleUp);
  }

  const sessionLoading = chat.paneSurface === 'session-loading';
  const showConversation = chat.paneSurface === 'chat'
    || chat.paneSurface === 'blank-session'
    || sessionLoading;
  const turnActive = chat.runState === 'running' || chat.runState === 'waiting';
  const hostSessionListMode = chat.sessionListMode ?? 'stacked';
  const isEntrySurface = !showConversation;
  const sessionOrientation = chat.settings?.sessionViewerOrientation ?? 'sideBySide';
  const showEntrySessions = isEntrySurface && hostSessionListMode !== 'hidden';
  const showConversationSidebar = showConversation && hostSessionListMode === 'sidebar';
  const sessionSidebarWidth = draggingSidebarWidth ?? chat.sessionSidebarWidth ?? 300;
  const lastAilyTurnId = [...chat.turns].reverse().find(turn => turn.role === 'aily')?.id ?? null;
  const activeSessionTitle = chat.sessions.find(item => item.id === chat.activeSessionId)?.title;

  const sessionSidebar = (variant: 'sidebar' | 'entry', className: string) => (
    <aside className={className} style={{ width: sessionSidebarWidth }}>
      <SessionList
        sessions={chat.sessions}
        activeSessionId={chat.activeSessionId}
        variant={variant}
        onSelect={selectSession}
      />
      <button
        type="button"
        className="chat-session-sidebar-resize-handle"
        aria-label={t('RESIZE_SESSION_SIDEBAR', '调整会话列表宽度')}
        onPointerDown={handleSessionSidebarResizeStart}
      >
        <span className="chat-session-sidebar-resize-handle-line" aria-hidden="true" />
      </button>
    </aside>
  );

  return (
    <XProvider
      theme={{
        algorithm: (chat.theme ?? chat.context.theme) === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          borderRadius: 5,
          fontSize: 13,
        },
      }}
    >
      <main className="aily-chat-wrapper">
      <div className="window-box" ref={windowBoxRef}>
        <div
          className={[
            'chat-main-layout',
            isEntrySurface ? 'is-entry-surface' : '',
            sessionOrientation === 'stacked' ? 'session-orientation-stacked' : 'session-orientation-side-by-side',
            showConversationSidebar ? 'has-session-sidebar' : '',
          ].filter(Boolean).join(' ')}
        >
          {showEntrySessions && sessionSidebar('sidebar', 'chat-session-sidebar chat-session-sidebar--entry')}
          {showConversationSidebar && sessionSidebar('sidebar', 'chat-session-sidebar chat-session-sidebar--conversation')}
          <section className="chat-stage">
            <header className="chat-pane-header">
              {showConversation && (
                <div className="session-title-control">
                  <button className="session-title-navigation-action" onClick={() => void invoke('surface.back')}>
                    <FaIcon icon="chevron-left" />
                  </button>
                  <button className="session-title-picker" onClick={event => toggleMenu('session', event)}>
                    <span>{activeSessionTitle || chat.title || t('TITLE', 'Aily Chat')}</span>
                    <FaIcon icon="chevron-down" />
                  </button>
                </div>
              )}
              <div className="host-header-actions">
                <button title={t('NEW_CHAT', '新建会话')} onClick={() => void invoke('session.create')}>
                  <FaIcon icon="plus" />
                </button>
                <button title={t('SETTINGS', '设置')} onClick={() => void invoke('surface.toggleSettings')}>
                  <FaIcon icon="gear" />
                </button>
              </div>
            </header>

            <div
              className={`dialog-list ${showConversation ? 'has-conversation' : 'is-entry-surface'}`}
              ref={timelineRef}
              onScroll={handleDialogScroll}
              onWheel={markDialogUserScrollIntent}
              onTouchMove={markDialogUserScrollIntent}
              onPointerDown={markDialogUserScrollIntent}
            >
              {showConversation ? (
                <div className="dialogs">
                  {chat.turns.map((turn, index) => (
                    <XDialog
                      key={`${chat.activeSessionId ?? 'none'}:${turn.id}`}
                      turn={turn}
                      runState={chat.runState}
                      isLastAily={turn.role === 'aily' && turn.id === lastAilyTurnId}
                      streamingActive={chat.runState === 'running' && index === chat.turns.length - 1}
                      editingTurnId={editingTurnId}
                      onEditStart={nextTurn => setEditingTurnId(nextTurn.id)}
                      onEditClose={() => setEditingTurnId(null)}
                      onEditModeMenu={event => toggleMenu('mode', event)}
                      onEditModelMenu={event => toggleMenu('model', event)}
                    />
                  ))}
                  {sessionLoading && (
                    <div className="dialog-loading">
                      <FaIcon icon="spinner-third" spin />
                      <span>{t('SESSION_LOADING', '正在恢复会话…')}</span>
                    </div>
                  )}
                  {!chat.turns.length && !sessionLoading && <div className="dialog-empty">{t('EMPTY_CHAT', '开始一段新对话')}</div>}
                </div>
              ) : (
                <>
                  <section className="guide-box entry-surface-guide">
                    <FaIcon icon="star-christmas" className="guide-icon" />
                    <div className="title">{t('SERVICE_TITLE', 'ai assistant service')}</div>
                    <div className="text">{t('DISCLAIMER', 'AI的回复仅能作为参考，不一定正确，也不代表本软件开发者的意见，使用者需自行辨别')}</div>
                    <div className="entry-session-actions">
                      <button
                        type="button"
                        className="btn link"
                        onClick={() => void invoke('surface.openUrl')}
                      >
                        {t('USAGE_GUIDE', '了解AI用法')}
                      </button>
                    </div>
                  </section>
                  {showEntrySessions && (
                    <div className={`entry-session-control entry-session-control--stacked entry-guide-stacked ${chat.sessions.length ? '' : 'is-empty'}`}>
                      <SessionList
                        sessions={chat.sessions}
                        activeSessionId={chat.activeSessionId}
                        variant="entry"
                        onSelect={selectSession}
                      />
                    </div>
                  )}
                </>
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
                  {chat.pendingPlanReview && <RuntimePlanReviewCarousel review={chat.pendingPlanReview} />}
                  {chat.pendingQuestion && <RuntimeQuestionCarousel question={chat.pendingQuestion} />}
                  {(chat.pendingConfirmations?.length ?? 0) > 0 && (
                    <RuntimeConfirmationCarousel
                      confirmations={chat.pendingConfirmations || []}
                      activeIndex={chat.activeConfirmationIndex ?? 0}
                    />
                  )}
                  <Sender
                    ref={composerRef}
                    rootClassName={`input-box ${turnActive ? 'working' : ''} ${(chat.pendingConfirmations?.length || chat.pendingQuestion || chat.pendingPlanReview) ? 'input-box-after-confirmation' : ''}`}
                    value={draft}
                    placeholder={t('PLACEHOLDER', '询问 Aily…')}
                    classNames={{ input: 'aily-chat-composer-input' }}
                    submitType="enter"
                    autoSize={{ minRows: 4, maxRows: 10 }}
                    suffix={false}
                    onFocus={() => setTodoFocused(true)}
                    onBlur={() => setTodoFocused(false)}
                    onChange={setDraft}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        void submit();
                        return false;
                      }
                    }}
                    onSubmit={value => void submit(value)}
                    onCancel={() => void stopTurn(chat.activeSessionId || '')}
                    header={!!chat.resources?.length && (
                      <div className="resource-list">
                        {chat.resources.map((resource, index) => (
                          <div className={`resource-item ${resource.type === 'block' ? 'block-item' : ''}`} key={`${resource.type}-${resource.blockId || resource.path || resource.name}-${index}`}>
                            <FaIcon icon={resourceIcon(resource.type)} />
                            <span>{resource.name}</span>
                            <button type="button" onClick={() => void invoke('resource.remove', { index })}>
                              <FaIcon icon="xmark" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    footer={(
                      <div className={`btns ${contextToolbarVisible ? 'has-expanded-context' : ''}`} data-focused={todoFocused}>
                      <div className="composer-context-actions">
                        <div className={`context-toolbar ${contextToolbarVisible ? 'is-expanded' : ''} ${contextExpanded ? 'is-open' : 'is-closing'}`}>
                          <button
                            type="button"
                            className="toolbar-button context-clip"
                            title={t('ATTACH', '添加上下文')}
                            onClick={toggleContextToolbar}
                          >
                            <FaIcon icon={contextToolbarVisible ? 'angle-left' : 'paperclip'} />
                          </button>
                          <span className="context-expand-backdrop" aria-hidden="true" />
                          <button
                            type="button"
                            className="toolbar-button context-sub-action"
                            title={t('ADD_FILE', '添加文件')}
                            aria-hidden={!contextExpanded}
                            disabled={!contextExpanded}
                            onClick={() => void invoke('resource.addFile')}
                          >
                            <FaIcon icon="file-plus" />
                          </button>
                          <button
                            type="button"
                            className="toolbar-button context-sub-action"
                            title={t('ADD_FOLDER', '添加文件夹')}
                            aria-hidden={!contextExpanded}
                            disabled={!contextExpanded}
                            onClick={() => void invoke('resource.addFolder')}
                          >
                            <FaIcon icon="folder-plus" />
                          </button>
                        </div>
                        <button type="button" className={`toolbar-chip ${contextToolbarVisible ? 'after-expanded-context' : ''}`} onClick={event => toggleMenu('mode', event)}>
                          <FaIcon iconClass={modeIconClass()} /><span>{modeLabel()}</span>
                        </button>
                        <button type="button" className="toolbar-chip permission-mode-indicator" onClick={event => toggleMenu('permission', event)}>
                          <FaIcon iconClass={permissionIconClass()} /><span>{(chat.permissionLabel || t('PERMISSION_DEFAULT', '默认权限')).slice(0, 2)}</span>
                        </button>
                        {chat.contextUsage && (
                          <button type="button" className={`token-budget-indicator severity-${chat.contextUsage.severity || 'normal'}`} title={chat.contextUsage.label}>
                            <span className="context-ring">{Math.round(chat.contextUsage.percentage)}</span>
                            {chat.contextUsage.estimated && <em>est</em>}
                          </button>
                        )}
                        {chat.interactionBudget?.label && (
                          <button type="button" className="quota-indicator">
                            <FaIcon icon="gauge-simple-high" /><em>{chat.interactionBudget.label}</em>
                          </button>
                        )}
                        {chat.authQuota?.label && (
                          <button type="button" className="quota-indicator">
                            <FaIcon icon="id-card" /><em>{chat.authQuota.label}</em>
                          </button>
                        )}
                        {chat.requestQuota?.label && (
                          <button type="button" className="quota-indicator">
                            <FaIcon icon="shield-exclamation" /><em>{chat.requestQuota.label}</em>
                          </button>
                        )}
                      </div>
                      <div className="composer-primary-actions">
                        <button type="button" className="composer-model-chip" onClick={event => toggleMenu('model', event)}>
                          <FaIcon icon="star-christmas" /><span>{chat.modelOptions?.find(option => option.id === chat.activeModelId)?.label || chat.models.find(model => model.id === chat.activeModelId)?.label || chat.activeModelId}</span>
                        </button>
                        {turnActive
                          ? (
                            <button type="button" className="primary-action stop-action" onClick={() => void stopTurn(chat.activeSessionId || '')}>
                              <span className="stop-box">
                                <FaIcon icon="stop" />
                              </span>
                              <span className="spinner-box" aria-hidden="true" />
                            </button>
                          )
                          : (
                            <button type="button" className="primary-action send-action" disabled={!draft.trim()} onClick={() => void submit()}>
                              <FaIcon icon={draft.includes('\n') ? 'arrow-up' : 'paper-plane'} />
                            </button>
                          )}
                      </div>
                      </div>
                    )}
                  />
                </div>
              </footer>
            )}
          </section>
        </div>

        {menu?.kind === 'session' && <PopupMenu kind="session" anchor={menu.anchor} placement="below" options={chat.sessions.map(item => ({ id: item.id, label: item.title, active: item.id === chat.activeSessionId }))} onSelect={option => void selectSession(option.id)} onClose={() => setMenu(null)} />}
        {menu?.kind === 'mode' && <PopupMenu kind="mode" anchor={menu.anchor} placement="above" options={chat.modeOptions || []} onSelect={option => handleMenuSelect('mode', option)} onClose={() => setMenu(null)} />}
        {menu?.kind === 'permission' && <PopupMenu kind="permission" anchor={menu.anchor} placement="above" options={[
          { id: 'default', label: t('PERMISSION_DEFAULT_LEGACY', '默认权限'), active: (chat.permissionPreset || chat.permissionMode) === 'default', iconClass: 'fa-light fa-shield-check' },
          { id: 'auto_review', label: t('PERMISSION_AUTO_REVIEW', '自动审查'), active: chat.permissionPreset === 'auto_review', iconClass: 'fa-light fa-robot' },
          { id: 'full', label: t('PERMISSION_FULL_LEGACY', '完全访问权限'), active: (chat.permissionPreset || chat.permissionMode) === 'full', iconClass: 'fa-light fa-triangle-exclamation', separatorBefore: true },
        ]} onSelect={option => { void invoke('settings.update', { permissionMode: option.id }); setMenu(null); }} onClose={() => setMenu(null)} />}
        {menu?.kind === 'model' && <PopupMenu kind="model" anchor={menu.anchor} placement="above" options={chat.modelOptions || []} onSelect={option => handleMenuSelect('model', option)} onClose={() => setMenu(null)} />}
      </div>
      </main>
    </XProvider>
  );
}
