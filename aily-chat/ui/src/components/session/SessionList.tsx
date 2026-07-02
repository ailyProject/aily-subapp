import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatSession, ChatSessionAction, invoke, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import './SessionList.scss';

const PRIMARY_ACTIONS = new Set(['pin-session', 'unpin-session']);
const OVERFLOW_ACTIONS = new Set([
  'archive-session',
  'unarchive-session',
  'rename-session',
  'delete-session',
]);

function defaultSessionActions(session: ChatSession): ChatSessionAction[] {
  const pinned = session.pinned === true;
  const archived = session.archived === true;
  return [
    {
      icon: 'fa-light fa-thumbtack',
      action: pinned ? 'unpin-session' : 'pin-session',
      title: pinned ? t('UNPIN_SESSION', '取消置顶') : t('PIN_SESSION', '置顶'),
      active: pinned,
    },
    {
      icon: archived ? 'fa-solid fa-archive' : 'fa-light fa-archive',
      action: archived ? 'unarchive-session' : 'archive-session',
      title: archived ? t('UNARCHIVE_SESSION', '取消归档') : t('ARCHIVE_SESSION', '归档'),
      active: archived,
    },
    { icon: 'fa-light fa-pen', action: 'rename-session', title: t('RENAME_SESSION', '重命名') },
    { icon: 'fa-light fa-trash', action: 'delete-session', title: t('DELETE_SESSION', '删除') },
  ];
}

function resolveSessionActions(session: ChatSession): ChatSessionAction[] {
  const actions = (session.actions?.length ? [...session.actions] : defaultSessionActions(session))
    .filter(action => action.action !== 'mark-session-read' && action.action !== 'mark-session-unread')
    .map(action => action.action === 'pin-session' || action.action === 'unpin-session'
      ? { ...action, icon: 'fa-light fa-thumbtack' }
      : action);
  const fallback = defaultSessionActions(session);
  for (const action of fallback) {
    if (!actions.some(item => item.action === action.action)) actions.push(action);
  }
  return actions;
}

function formatStatus(status?: string): string {
  const normalized = String(status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized || normalized === 'completed' || normalized === 'idle') return '';
  if (['in_progress', 'running', 'waiting_tool_results'].includes(normalized)) return t('SESSION_STATUS_RUNNING', '进行中');
  if (['needs_input', 'waiting_question', 'waiting_confirmation'].includes(normalized)) return t('SESSION_STATUS_NEEDS_INPUT', '需要输入');
  if (['failed', 'hard_stopped', 'error'].includes(normalized)) return t('SESSION_STATUS_FAILED', '失败');
  if (['cancelled', 'stopped'].includes(normalized)) return t('SESSION_STATUS_STOPPED', '已停止');
  return status || '';
}

function statusClass(status?: string): string {
  return String(status || 'idle').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function formatSessionTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const documentLang = document.documentElement.lang.toLowerCase();
  const locale = documentLang === 'zh_cn'
    ? 'zh-CN'
    : documentLang === 'zh_hk'
      ? 'zh-HK'
      : documentLang.replace(/_/g, '-') || undefined;
  const diffMs = timestamp - Date.now();
  const absMs = Math.abs(diffMs);
  const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (absMs < 60_000) return relativeTime.format(Math.round(diffMs / 1_000), 'second');
  if (absMs < 3_600_000) return relativeTime.format(Math.round(diffMs / 60_000), 'minute');
  if (absMs < 86_400_000) return relativeTime.format(Math.round(diffMs / 3_600_000), 'hour');
  if (absMs < 604_800_000) return relativeTime.format(Math.round(diffMs / 86_400_000), 'day');
  return relativeTime.format(Math.round(diffMs / 604_800_000), 'week');
}

function groupLabel(group: SessionGroup['id']): string {
  if (group === 'pinned') return t('PINNED', 'Pinned');
  if (group === 'today') return t('TODAY', 'Today');
  if (group === 'yesterday') return t('YESTERDAY', 'Yesterday');
  if (group === 'week') return t('LAST_7_DAYS', 'Last 7 Days');
  if (group === 'older') return t('OLDER', 'Older');
  if (group === 'archived') return t('ARCHIVED', 'Archived');
  return '';
}

function sessionIdentity(session: ChatSession): string {
  const legacySessionId = (session as ChatSession & { sessionId?: unknown }).sessionId;
  return String(session.id || legacySessionId || '').trim();
}

interface SessionGroup {
  id: 'pinned' | 'today' | 'yesterday' | 'week' | 'older' | 'archived';
  sessions: ChatSession[];
}

function groupSessionsByDate(sessions: ChatSession[]): SessionGroup[] {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1_000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday - day;
  const recentWeekThreshold = now - 7 * day;
  const groups: SessionGroup[] = [
    { id: 'pinned', sessions: [] },
    { id: 'today', sessions: [] },
    { id: 'yesterday', sessions: [] },
    { id: 'week', sessions: [] },
    { id: 'older', sessions: [] },
    { id: 'archived', sessions: [] },
  ];
  const sorted = [...sessions].sort((left, right) => {
    const timeDelta = (right.createdAt ?? right.updatedAt) - (left.createdAt ?? left.updatedAt);
    return timeDelta || left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
  });

  for (const session of sorted) {
    if (session.archived) {
      groups[5].sessions.push(session);
      continue;
    }
    if (session.pinned) {
      groups[0].sessions.push(session);
      continue;
    }
    const createdAt = session.createdAt ?? session.updatedAt;
    if (!Number.isFinite(createdAt) || createdAt <= 0 || createdAt < recentWeekThreshold) {
      groups[4].sessions.push(session);
    } else if (createdAt >= startOfToday) {
      groups[1].sessions.push(session);
    } else if (createdAt >= startOfYesterday) {
      groups[2].sessions.push(session);
    } else {
      groups[3].sessions.push(session);
    }
  }
  return groups.filter(group => group.sessions.length > 0);
}

function SessionRow({
  session,
  active,
  overflowOpen,
  onSelect,
  onToggleOverflow,
  onAction,
}: {
  session: ChatSession;
  active: boolean;
  overflowOpen: boolean;
  onSelect(): void;
  onToggleOverflow(): void;
  onAction(action: ChatSessionAction): void;
}) {
  const actions = resolveSessionActions(session);
  const primaryActions = actions.filter(action => PRIMARY_ACTIONS.has(action.action));
  const overflowActions = actions.filter(action => OVERFLOW_ACTIONS.has(action.action));
  const status = formatStatus(session.status);
  const time = formatSessionTime(session.updatedAt);
  const showSpinner = ['running', 'in_progress'].includes(String(session.status || '').toLowerCase());

  return (
    <div
      className={`session-list-row ${overflowOpen ? 'session-list-row-overflow-open' : ''}`}
      data-selected={active}
      data-current={session.current === true}
      data-has-toggle-action={session.pinned === true || session.archived === true}
    >
      <button type="button" className="session-list-item" onClick={onSelect}>
        <span className="session-list-copy">
          <span className="session-list-item-title-row">
            <span className="session-list-activity-indicator" aria-hidden="true">
              {showSpinner
                ? <FaIcon icon="spinner-third" className="session-spinner" spin />
                : session.unread ? <span className="session-list-unread-dot" /> : null}
            </span>
            <span className="session-list-item-title">{session.title}</span>
          </span>
          {(status || time) && (
            <span className="session-list-item-meta-row">
              {status && <span className={`session-list-item-status status-${statusClass(session.status)}`}>{status}</span>}
              {status && time && <span className="session-list-meta-separator">·</span>}
              {time && <time dateTime={new Date(session.updatedAt).toISOString()}>{time}</time>}
            </span>
          )}
        </span>
      </button>
      <div className="session-list-actions">
        {primaryActions.map(action => (
          <button
            type="button"
            key={action.action}
            className={`session-list-action session-list-action-toggle ${action.active ? 'active' : ''}`}
            data-session-action={action.action}
            aria-label={action.title}
            title={action.title}
            onClick={() => onAction(action)}
          >
            <FaIcon iconClass={action.icon} className="session-list-action-icon" />
          </button>
        ))}
        {overflowActions.length > 0 && (
          <div className={`session-list-actions-more ${overflowOpen ? 'open' : ''}`}>
            <button
              type="button"
              className="session-list-action session-list-action-more"
              aria-label={t('MORE', '更多')}
              aria-expanded={overflowOpen}
              aria-haspopup="menu"
              onClick={onToggleOverflow}
            >
              <FaIcon icon="ellipsis" />
            </button>
            <div className="session-list-actions-overflow" role="menu">
              {overflowActions.map(action => (
                <button
                  type="button"
                  key={action.action}
                  className={`session-list-overflow-action ${action.active ? 'active' : ''}`}
                  role="menuitem"
                  onClick={() => onAction(action)}
                >
                  <FaIcon iconClass={action.icon} className="session-list-action-icon" />
                  <span>{action.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SessionList({
  sessions,
  activeSessionId,
  variant = 'sidebar',
  onSelect,
}: {
  sessions: ChatSession[];
  activeSessionId: string | null;
  variant?: 'sidebar' | 'entry';
  onSelect(id: string): void;
}) {
  const [openOverflowSessionId, setOpenOverflowSessionId] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const groups = useMemo(() => groupSessionsByDate(sessions), [sessions]);
  const selectedSessionId = String(activeSessionId || '').trim();

  useEffect(() => {
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.session-list-actions-more')) return;
      setOpenOverflowSessionId('');
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenOverflowSessionId('');
    };
    document.addEventListener('click', close);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, []);

  const handleSessionAction = useCallback(async (session: ChatSession, action: ChatSessionAction): Promise<void> => {
    setOpenOverflowSessionId('');
    if (action.action === 'rename-session') {
      const nextTitle = window.prompt(t('RENAME_SESSION', '重命名会话'), session.title)?.trim();
      if (!nextTitle || nextTitle === session.title) return;
      await invoke('session.action', { sessionId: session.id, action: action.action, title: nextTitle });
      return;
    }
    if (action.action === 'delete-session') {
      if (!window.confirm(`${t('DELETE_SESSION', '删除会话')} "${session.title}"?`)) return;
    }
    await invoke('session.action', { sessionId: session.id, action: action.action });
  }, []);

  return (
    <section className={`session-list-panel ${variant === 'entry' ? 'entry' : ''}`} ref={panelRef}>
      <header className="session-list-header">
        <span className="session-list-title">{t('SESSIONS', 'Sessions')}</span>
      </header>
      <div className="session-list-body">
        {groups.length ? (
          <div className="session-list-items">
            {groups.map(group => (
              <div className="session-list-group" key={group.id}>
                {groupLabel(group.id) && <div className="session-list-section-label">{groupLabel(group.id)}</div>}
                {group.sessions.map(session => (
                  <SessionRow
                    key={sessionIdentity(session)}
                    session={session}
                    active={Boolean(selectedSessionId) && sessionIdentity(session) === selectedSessionId}
                    overflowOpen={openOverflowSessionId === sessionIdentity(session)}
                    onSelect={() => {
                      setOpenOverflowSessionId('');
                      onSelect(sessionIdentity(session));
                    }}
                    onToggleOverflow={() => setOpenOverflowSessionId(current => current === sessionIdentity(session) ? '' : sessionIdentity(session))}
                    onAction={action => void handleSessionAction(session, action)}
                  />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="session-list-empty">{t('NO_SESSIONS', '暂无会话')}</div>
        )}
      </div>
    </section>
  );
}
