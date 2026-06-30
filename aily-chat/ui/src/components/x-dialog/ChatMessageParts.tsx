import { memo, useMemo } from 'react';
import { ChatPart } from '../../protocol';
import { ChatActivityGroup } from './ChatActivityGroup';
import { ChatMessagePartItem } from './ChatMessagePartItem';
import './chat-message-parts.scss';

const ACTIVITY_TYPES = new Set<ChatPart['type']>(['thinking', 'tool', 'tool_call', 'state', 'terminal', 'confirmation']);

type PartRenderItem = { kind: 'part'; id: string; part: ChatPart };
type GroupRenderItem = { kind: 'group'; id: string; parts: ChatPart[]; live: boolean };
type RenderItem = PartRenderItem | GroupRenderItem;

export const ChatMessageParts = memo(function ChatMessageParts({
  parts,
  doing,
}: {
  parts: ChatPart[];
  doing: boolean;
}) {
  const items = useMemo(() => markLiveActivityGroups(projectParts(parts), doing), [parts, doing]);
  return items.map(item => item.kind === 'group'
    ? <ChatActivityGroup key={item.id} parts={item.parts} doing={item.live} />
    : <div className="chat-part" data-part-type={item.part.type} key={item.id}><ChatMessagePartItem part={item.part} doing={doing} /></div>);
});

function projectParts(parts: ChatPart[]): RenderItem[] {
  const result: RenderItem[] = [];
  let group: ChatPart[] = [];
  const flush = () => {
    if (!group.length) return;
    result.push({ kind: 'group', id: `group:${group.map(part => part.id).join(':')}`, parts: group, live: false });
    group = [];
  };
  for (const part of parts) {
    if (ACTIVITY_TYPES.has(part.type)) {
      group.push(part);
    } else {
      flush();
      result.push({ kind: 'part', id: `part:${part.id}`, part });
    }
  }
  flush();
  return result;
}

/** Only the trailing activity group is live while the turn is running — matches Angular markLiveActivityGroups. */
function markLiveActivityGroups(items: RenderItem[], doing: boolean): RenderItem[] {
  if (!doing || items.length === 0) {
    return items.map(item => item.kind === 'group' ? { ...item, live: false } : item);
  }

  return items.map((item, index) => item.kind === 'group'
    ? { ...item, live: !hasLookAheadBoundary(items, index) }
    : item);
}

function hasLookAheadBoundary(items: readonly RenderItem[], groupIndex: number): boolean {
  for (let index = groupIndex + 1; index < items.length; index += 1) {
    if (items[index].kind === 'part') {
      return true;
    }
  }
  return false;
}
