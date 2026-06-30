import { ChatPart, invoke } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import { XAilyMarkdownViewer } from './XAilyMarkdownViewer';
import './x-aily-card-viewers.scss';

export function XAilyPlanViewer({ part }: { part: ChatPart }) {
  return (
    <section className="x-aily-plan-card" data-plan-status={part.status || part.state}>
      <header><FaIcon icon="list-check" /><strong>{part.title || 'Plan'}</strong><span>{part.status}</span></header>
      <div className="x-aily-plan-card-body"><XAilyMarkdownViewer content={part.text || part.content || ''} streaming={part.status === 'streaming'} /></div>
      {part.actions?.length ? (
        <footer>
          {part.actions.map(action => (
            <button key={action.id} className={action.primary ? 'primary' : ''} onClick={() => void invoke('interaction.respond', { partId: part.id, actionId: action.id })}>
              {action.label}
            </button>
          ))}
        </footer>
      ) : null}
    </section>
  );
}
