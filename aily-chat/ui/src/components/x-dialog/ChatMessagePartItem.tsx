import { memo } from 'react';
import { ChatPart } from '../../protocol';
import { ChatActivityGroup } from './ChatActivityGroup';
import { XAilyConfirmationViewer } from './XAilyConfirmationViewer';
import { XAilyErrorViewer } from './XAilyErrorViewer';
import { XAilyMarkdownViewer } from './XAilyMarkdownViewer';
import { XAilyPlanViewer } from './XAilyPlanViewer';
import { XAilyProgressViewer } from './XAilyProgressViewer';
import { XAilyQuestionViewer } from './XAilyQuestionViewer';

export const ChatMessagePartItem = memo(function ChatMessagePartItem({
  part,
  doing = false,
}: {
  part: ChatPart;
  doing?: boolean;
}) {
  const type = part.type === 'tool_call' ? 'tool' : part.type;
  if (type === 'markdown') return <XAilyMarkdownViewer content={part.content || part.text || ''} streaming={doing || part.streaming === true} />;
  if (type === 'error') return <XAilyErrorViewer part={part} />;
  if (type === 'question') return <XAilyQuestionViewer part={part} />;
  if (type === 'confirmation') return <XAilyConfirmationViewer part={part} />;
  if (type === 'plan') return <XAilyPlanViewer part={part} />;
  if (type === 'progress') return <XAilyProgressViewer part={part} />;
  return <ChatActivityGroup parts={[part]} doing={doing || part.state === 'doing'} />;
});
