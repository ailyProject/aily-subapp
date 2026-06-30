import { useMemo, useState } from 'react';
import { ChatRuntimePlanReview, invoke, t } from '../../protocol';
import { FaIcon } from '../shared/Icon';

export function RuntimePlanReviewCarousel({ review }: { review: ChatRuntimePlanReview }) {
  const defaultActionId = useMemo(() => {
    const preferred = review.actions.find(action => action.default) ?? review.actions[0];
    return preferred?.id ?? '';
  }, [review.id, review.actions]);

  const [selectedActionId, setSelectedActionId] = useState(defaultActionId);
  const [feedbackMode, setFeedbackMode] = useState(false);
  const [feedback, setFeedback] = useState('');

  const selectedAction = review.actions.find(action => action.id === (selectedActionId || defaultActionId));
  const otherActions = review.actions.filter(action => action.id !== (selectedActionId || defaultActionId));

  function approve(): void {
    void invoke('plan.respond', {
      approved: true,
      actionId: selectedActionId || defaultActionId,
      feedback: feedback.trim() || undefined,
    });
  }

  function reject(): void {
    void invoke('plan.respond', { approved: false, feedback: feedback.trim() || undefined });
  }

  return (
    <section className="runtime-plan-review has-plan-review">
      <header className="rtc-viewer-header">
        <FaIcon icon="list-check" />
        <div className="rtc-viewer-copy">
          <strong>{review.title || t('PLAN_REVIEW', '计划审阅')}</strong>
        </div>
      </header>
      <div className="rpr-content">{review.content}</div>
      {review.canProvideFeedback && feedbackMode && (
        <textarea
          className="rtq-freeform"
          rows={2}
          placeholder={t('PLAN_FEEDBACK', '填写修改意见…')}
          value={feedback}
          onChange={event => setFeedback(event.target.value)}
        />
      )}
      <div className="cca-actions">
        <button type="button" className="cca-btn-primary cca-btn-primary-standalone" onClick={approve}>
          {selectedAction?.label || t('APPROVE_PLAN', '批准计划')}
        </button>
        {otherActions.map(action => (
          <button key={action.id} type="button" className="cca-btn-reject" title={action.description} onClick={() => setSelectedActionId(action.id)}>
            {action.label}
          </button>
        ))}
        {review.canProvideFeedback && (
          <button type="button" className="cca-btn-reject" onClick={() => setFeedbackMode(value => !value)}>
            {t('PLAN_PROVIDE_FEEDBACK', '修改意见')}
          </button>
        )}
        <button type="button" className="cca-btn-reject" onClick={reject}>{t('REJECT', '拒绝')}</button>
      </div>
    </section>
  );
}
