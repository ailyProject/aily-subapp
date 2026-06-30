import { ChatPart, invoke, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import './x-aily-card-viewers.scss';

export function XAilyConfirmationViewer({ part }: { part: ChatPart }) {
  return (
    <section className="x-aily-inline-card confirmation-card">
      <header><FaIcon icon="circle-pause" /><strong>{part.title || t('CONFIRM', '确认操作')}</strong></header>
      <p>{part.content || part.detail}</p>
      <footer>
        {(part.actions || []).map(action => (
          <button
            key={action.id}
            className={action.primary ? 'primary' : action.danger ? 'danger' : ''}
            onClick={() => void invoke('interaction.respond', {
              approved: !action.danger,
              partId: part.id,
              actionId: action.id,
              value: action.id,
            })}
          >
            {action.label}
          </button>
        ))}
      </footer>
    </section>
  );
}
