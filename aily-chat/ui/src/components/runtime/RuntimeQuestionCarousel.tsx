import { useMemo, useState } from 'react';
import { ChatRuntimeQuestion, invoke, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';

interface AnswerDraft {
  selected: string[];
  freeText: string;
}

export function RuntimeQuestionCarousel({ question }: { question: ChatRuntimeQuestion }) {
  const initial = useMemo<Record<number, AnswerDraft>>(() => {
    const map: Record<number, AnswerDraft> = {};
    question.questions.forEach((_item, index) => {
      map[index] = { selected: [], freeText: '' };
    });
    return map;
  }, [question.partId, question.questions.length]);

  const [drafts, setDrafts] = useState<Record<number, AnswerDraft>>(initial);

  function toggleOption(index: number, label: string, multi: boolean): void {
    setDrafts(current => {
      const draft = current[index] ?? { selected: [], freeText: '' };
      const selected = multi
        ? draft.selected.includes(label)
          ? draft.selected.filter(item => item !== label)
          : [...draft.selected, label]
        : draft.selected.includes(label) ? [] : [label];
      return { ...current, [index]: { ...draft, selected } };
    });
  }

  function setFreeText(index: number, value: string): void {
    setDrafts(current => ({
      ...current,
      [index]: { ...(current[index] ?? { selected: [], freeText: '' }), freeText: value },
    }));
  }

  const canSubmit = question.questions.every((item, index) => {
    const draft = drafts[index] ?? { selected: [], freeText: '' };
    return draft.selected.length > 0 || draft.freeText.trim().length > 0 || (item.options.length === 0 && item.allowFreeform);
  });

  function submit(): void {
    const answers = question.questions.map((item, index) => {
      const draft = drafts[index] ?? { selected: [], freeText: '' };
      return {
        question: item.question,
        selected: draft.selected,
        freeText: draft.freeText.trim() || null,
      };
    });
    void invoke('question.respond', { answers });
  }

  function skip(): void {
    void invoke('question.respond', { skipped: true });
  }

  return (
    <section className="runtime-question-carousel has-question">
      {question.questions.map((item, index) => {
        const draft = drafts[index] ?? { selected: [], freeText: '' };
        return (
          <div className="rtq-question" key={`${question.partId}-${index}`}>
            <div className="rtq-question-title">
              <FaIcon icon="circle-question" />
              <span>{item.question}</span>
            </div>
            {item.options.length > 0 && (
              <div className="rtq-options">
                {item.options.map(option => {
                  const checked = draft.selected.includes(option.label);
                  return (
                    <button
                      key={option.label}
                      type="button"
                      className={`rtq-option ${checked ? 'rtq-checked' : ''}`}
                      onClick={() => toggleOption(index, option.label, item.multiSelect === true)}
                    >
                      <FaIcon icon={checked ? 'circle-check' : 'circle'} />
                      <span className="rtq-option-copy">
                        <strong>{option.label}{option.recommended && <em className="rtq-recommended">{t('RECOMMENDED', '推荐')}</em>}</strong>
                        {option.description && <small>{option.description}</small>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {item.allowFreeform && (
              <textarea
                className="rtq-freeform"
                rows={2}
                placeholder={t('QUESTION_FREEFORM', '输入你的回答…')}
                value={draft.freeText}
                onChange={event => setFreeText(index, event.target.value)}
              />
            )}
          </div>
        );
      })}
      <div className="rtq-actions">
        <button type="button" className="cca-btn-reject" onClick={skip}>{t('SKIP', '跳过')}</button>
        <button type="button" className="cca-btn-primary cca-btn-primary-standalone" disabled={!canSubmit} onClick={submit}>
          {t('SUBMIT', '提交')}
        </button>
      </div>
    </section>
  );
}
