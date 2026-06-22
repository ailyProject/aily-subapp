import { memo, useMemo } from 'react';
import { ChatPart } from '../../protocol';
import { ChatActivityGroup } from './ChatActivityGroup';
import { ChatMessagePartItem } from './ChatMessagePartItem';
import './chat-message-parts.css';

const ACTIVITY_TYPES = new Set<ChatPart['type']>(['thinking', 'tool', 'tool_call', 'state', 'terminal', 'confirmation']);

export const ChatMessageParts = memo(function ChatMessageParts({
  parts,
  doing,
}: {
  parts: ChatPart[];
  doing: boolean;
}) {
  const items = useMemo(() => projectParts(parts), [parts]);
  return items.map(item => item.kind === 'group'
    ? <ChatActivityGroup key={item.id} parts={item.parts} doing={doing} />
    : <div className="chat-part" data-part-type={item.part.type} key={item.id}><ChatMessagePartItem part={item.part} doing={doing} /></div>);
});

function projectParts(parts: ChatPart[]): Array<
  { kind: 'group'; id: string; parts: ChatPart[] }
  | { kind: 'part'; id: string; part: ChatPart }
> {
  const result: Array<
    { kind: 'group'; id: string; parts: ChatPart[] }
    | { kind: 'part'; id: string; part: ChatPart }
  > = [];
  let group: ChatPart[] = [];
  const flush = () => {
    if (!group.length) return;
    result.push({ kind: 'group', id: `group:${group.map(part => part.id).join(':')}`, parts: group });
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
