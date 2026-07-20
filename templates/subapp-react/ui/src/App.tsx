import { FormEvent, memo, useEffect, useState } from 'react';
import { bootstrapRuntime, reportError, request, translate, useRuntime } from './runtime';

const StatusPill = memo(function StatusPill({ state }: { state: string }) {
  return <span className={`status ${state}`}>{translate(`STATUS_${state.toUpperCase()}`, state)}</span>;
});

export default function App() {
  const runtime = useRuntime();
  const [message, setMessage] = useState(() => localStorage.getItem('{{tool-id}}.react.ui.draft.v1') || 'hello');
  const [result, setResult] = useState('');

  useEffect(() => {
    void bootstrapRuntime();
  }, []);

  useEffect(() => {
    localStorage.setItem('{{tool-id}}.react.ui.draft.v1', message);
  }, [message]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      const response = await request('sample.echo', { message });
      setResult(JSON.stringify(response, null, 2));
    } catch (error) {
      reportError(error);
      setResult(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <main className="tool-shell">
      <header className="toolbar">
        <div className="title-block">
          <h1>{translate('TITLE', '{{Tool Name}}')}</h1>
          <p>{translate('DESCRIPTION', '{{tool-description}}')}</p>
        </div>
        <StatusPill state={runtime.backendState} />
      </header>

      <section className="workspace">
        <form className="panel command-panel" onSubmit={submit}>
          <div className="panel-title">{translate('COMMAND', 'Command')}</div>
          <label className="field">
            <span>{translate('MESSAGE', 'Message')}</span>
            <input value={message} onChange={event => setMessage(event.target.value)} />
          </label>
          <div className="actions">
            <button className="primary" disabled={runtime.backendState !== 'ready'}>{translate('RUN', 'Run')}</button>
            <button type="button" onClick={() => setResult('')}>{translate('CLEAR', 'Clear')}</button>
          </div>
        </form>

        <section className="panel result-panel">
          <div className="panel-title">{translate('RESULT', 'Result')}</div>
          <pre className="mono">{result || '—'}</pre>
        </section>
      </section>
    </main>
  );
}
