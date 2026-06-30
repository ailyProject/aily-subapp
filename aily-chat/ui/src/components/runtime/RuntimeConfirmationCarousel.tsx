import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChatRuntimeConfirmation, invoke, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';

const TERMINAL_TOOLS = new Set([
  'run_in_terminal',
  'command_exec',
  'send_to_terminal',
  'command_write_stdin',
  'command_resize',
  'kill_terminal',
  'command_stop',
  'execute_command',
]);

function normalizeToolName(value: string | undefined): string {
  return String(value || '').trim().toLowerCase();
}

function isTerminalTool(toolName: string | undefined): boolean {
  return TERMINAL_TOOLS.has(normalizeToolName(toolName));
}

function getCommandPreview(args: Record<string, unknown> | undefined): string {
  const command = args?.['command'];
  return typeof command === 'string' ? command.trim() : '';
}

function getCommandMeta(toolName: string, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  if (isTerminalTool(toolName) && typeof args['goal'] === 'string' && args['goal'].trim()) {
    return `目标：${args['goal'].trim()}`;
  }
  if (normalizeToolName(toolName) === 'execute_command' && typeof args['cwd'] === 'string' && args['cwd'].trim()) {
    return `工作目录：${args['cwd'].trim()}`;
  }
  return '';
}

function getDisplayMessage(toolName: string, message: string, commandPreview: string): string {
  if (!message) return '';
  if (!commandPreview) return message;
  if (isTerminalTool(toolName)) return '执行前请确认此终端命令。';
  if (normalizeToolName(toolName) === 'execute_command') return '执行前请确认此命令。';
  return message;
}

function getActionMenuLabel(scope: string, label: string): string {
  switch (scope) {
    case 'session':
      return '本对话总是允许';
    case 'workspace':
      return '工作区总是允许';
    case 'session-all-terminal':
      return '本对话允许全部终端命令';
    case 'session-safe':
      return '本对话允许安全终端命令';
    default:
      return label;
  }
}

function getPrimaryButtonLabel(kind: string, primaryScope: string, customLabel?: string): string {
  if (customLabel) return customLabel;
  if (kind === 'confirmation') return t('CONFIRM', '确认');
  switch (primaryScope) {
    case 'session':
      return '本对话总是允许';
    case 'workspace':
      return '工作区总是允许';
    case 'session-all-terminal':
      return '本对话允许全部终端命令';
    case 'session-safe':
      return '本对话允许安全终端命令';
    default:
      return t('ALLOW', '允许');
  }
}

function getPrimaryActionValue(primaryScope: string, actions: ChatRuntimeConfirmation['actions']): string {
  if (primaryScope === 'once') return 'once';
  return actions.find(action => action.scope === primaryScope)?.id || primaryScope;
}

export function RuntimeConfirmationCarousel({
  confirmations,
  activeIndex,
}: {
  confirmations: ChatRuntimeConfirmation[];
  activeIndex: number;
}) {
  const active = confirmations[activeIndex] ?? confirmations[0] ?? null;
  if (!active) return null;

  return (
    <section className="runtime-confirmation-carousel has-confirmation">
      {confirmations.length > 1 && (
        <header className="rtc-header">
          <div className="rtc-title-group">
            <div className="rtc-title">{active.kind === 'approval' ? t('TOOL_APPROVAL', '工具审批') : t('CONFIRM_REQUEST', '确认请求')}</div>
            <div className="rtc-step">{activeIndex + 1}/{confirmations.length}</div>
          </div>
          <div className="rtc-nav">
            <button type="button" className="rtc-nav-btn" aria-label={t('PREV_CONFIRMATION', '上一个确认')} onClick={() => void invoke('confirmation.navigate', { delta: -1 })}>
              <FaIcon icon="chevron-left" />
            </button>
            <button type="button" className="rtc-nav-btn" aria-label={t('NEXT_CONFIRMATION', '下一个确认')} onClick={() => void invoke('confirmation.navigate', { delta: 1 })}>
              <FaIcon icon="chevron-right" />
            </button>
          </div>
        </header>
      )}
      <RuntimeConfirmationViewer confirmation={active} />
    </section>
  );
}

function RuntimeConfirmationViewer({ confirmation }: { confirmation: ChatRuntimeConfirmation }) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const caretRef = useRef<HTMLButtonElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });
  const toolName = normalizeToolName(confirmation.toolName);
  const args = confirmation.args;
  const commandPreview = getCommandPreview(args);
  const commandMeta = getCommandMeta(toolName, args);
  const displayMessage = getDisplayMessage(toolName, confirmation.message, commandPreview);
  const primaryScope = confirmation.primaryScope || 'once';
  const primaryLabel = getPrimaryButtonLabel(confirmation.kind, primaryScope, confirmation.primaryLabel);
  const primaryValue = getPrimaryActionValue(primaryScope, confirmation.actions);
  const rejectLabel = confirmation.rejectLabel?.trim() || t('SKIP', '跳过');
  const menuActions = useMemo(
    () => confirmation.actions.filter(action => action.scope !== primaryScope),
    [confirmation.actions, primaryScope],
  );

  useEffect(() => {
    if (!dropdownOpen) return;
    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (dropdownRef.current?.contains(target) || caretRef.current?.contains(target)) {
        return;
      }
      setDropdownOpen(false);
    };
    const handleReposition = () => {
      const rect = caretRef.current?.getBoundingClientRect();
      if (rect) {
        setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
      }
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [dropdownOpen]);

  function respond(payload: Record<string, unknown>): void {
    void invoke('interaction.respond', {
      toolCallId: confirmation.toolCallId,
      confirmationId: confirmation.id,
      ...payload,
    });
  }

  function approve(scope: string, actionId?: string): void {
    respond({ approved: true, scope, actionId });
  }

  function reject(): void {
    respond({ approved: false, reason: '用户拒绝执行' });
  }

  function openDropdown(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    setDropdownOpen(value => !value);
  }

  function selectOption(scope: string, actionId: string): void {
    setDropdownOpen(false);
    approve(scope, actionId);
  }

  return (
    <div className="rtc-viewer">
      <header className="rtc-viewer-header">
        <FaIcon icon="circle-pause" />
        <div className="rtc-viewer-copy">
          <strong>{confirmation.title || t('CONFIRM', '确认操作')}</strong>
          {confirmation.subtitle && <span>{confirmation.subtitle}</span>}
        </div>
      </header>
      <div className="rtc-viewer-body">
        {commandPreview && (
          <div className="cmdp-block">
            {commandMeta && <div className="cmdp-meta">{commandMeta}</div>}
            <pre className="cmdp-command"><code>{commandPreview}</code></pre>
          </div>
        )}
        {displayMessage && <div className="rtc-message">{displayMessage}</div>}
        <div className="cca-actions">
          <div className="cca-split-btn">
            <button
              type="button"
              className={`cca-btn-primary ${menuActions.length === 0 ? 'cca-btn-primary-standalone' : ''}`}
              title={primaryScope === 'once' ? '允许这次执行' : primaryLabel}
              onClick={() => approve(primaryScope, primaryValue === 'once' ? undefined : primaryValue)}
            >
              {primaryLabel}
            </button>
            {menuActions.length > 0 && (
              <>
                <button
                  ref={caretRef}
                  type="button"
                  className="cca-btn-caret"
                  title={t('MORE_ALLOW_OPTIONS', '显示更多允许选项')}
                  onClick={openDropdown}
                >
                  <FaIcon icon="chevron-down" />
                </button>
                {dropdownOpen && createPortal(
                  <div
                    ref={dropdownRef}
                    className="cca-dropdown"
                    style={{ top: dropdownPos.top, left: dropdownPos.left, minWidth: Math.max(220, dropdownPos.width) }}
                  >
                    {menuActions.map(action => (
                      <button
                        key={action.id}
                        type="button"
                        className={`cca-dropdown-item ${action.isSecondary ? 'cca-dropdown-item-secondary' : ''}`}
                        disabled={action.disabled}
                        title={action.tooltip || action.description || action.label}
                        onClick={() => selectOption(action.scope, action.id)}
                      >
                        {getActionMenuLabel(action.scope, action.label)}
                      </button>
                    ))}
                  </div>,
                  document.body,
                )}
              </>
            )}
          </div>
          <button type="button" className="cca-btn-reject" title="继续当前对话，但不执行此操作" onClick={reject}>
            {rejectLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
