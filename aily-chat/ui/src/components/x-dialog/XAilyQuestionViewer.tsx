import { ChatPart, invoke, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';
import './x-aily-card-viewers.scss';

export function XAilyQuestionViewer({ part }: { part: ChatPart }) {
  return (
    <section className="x-aily-inline-card question-card">
      <header><FaIcon icon="circle-question" /><strong>{part.title || t('QUESTION', '需要你的回答')}</strong></header>
      {part.questions?.map((question, index) => (
        <div className="question-item" key={question.id || index}>
          <div>{question.question}</div>
          <div className="choice-list">
            {question.options?.map(option => (
              <button key={option.label} onClick={() => void invoke('interaction.respond', {
                partId: part.id, question: index, value: option.label,
              })}>
                <span>{option.label}</span>
                {option.description && <small>{option.description}</small>}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
