'use strict';

const crypto = require('crypto');

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const PAUSED_STATES = new Set(['paused', 'taken_over']);

class ScenarioController {
  constructor(options = {}) {
    this.emit = typeof options.emit === 'function' ? options.emit : null;
    this.active = null;
    this.lastScenario = null;
  }

  status() {
    return {
      active: Boolean(this.active),
      scenario: this.active ? this.snapshotScenario(this.active) : null,
      lastScenario: this.lastScenario
    };
  }

  start(params = {}, context = {}, externalSignal) {
    if (this.active) {
      throw createScenarioControlError(
        'SCENARIO_ALREADY_ACTIVE',
        `Scenario ${this.active.scenarioId} is already active`,
        { scenario: this.snapshotScenario(this.active) }
      );
    }

    const scenarioId = String(params.scenarioId || createScenarioId());
    const abortController = new AbortController();
    const run = {
      scenarioId,
      name: String(params.name || 'Serial scenario').slice(0, 200),
      state: 'running',
      owner: actorIdentity(context),
      takeoverOwner: null,
      reason: '',
      requestMode: '',
      requestedAt: 0,
      startedAt: Date.now(),
      pausedAt: 0,
      totalPausedMs: 0,
      stepCount: Array.isArray(params.steps) ? params.steps.length : 0,
      completedSteps: 0,
      currentStep: null,
      stepActive: false,
      abortController,
      waiters: new Set(),
      unlinkExternalSignal: () => undefined
    };
    this.active = run;

    const onExternalAbort = () => {
      this.cancelRun(run, { actor: 'system', actorId: 'request-signal' }, 'request_cancelled');
    };
    if (externalSignal?.aborted) {
      onExternalAbort();
    } else {
      externalSignal?.addEventListener?.('abort', onExternalAbort, { once: true });
      run.unlinkExternalSignal = () => {
        externalSignal?.removeEventListener?.('abort', onExternalAbort);
      };
    }

    return {
      scenarioId,
      signal: abortController.signal,
      checkpoint: details => this.checkpoint(run, details),
      stepStarted: details => this.stepStarted(run, details),
      stepFinished: details => this.stepFinished(run, details),
      wait: (durationMs, signal, details) => this.cooperativeWait(run, durationMs, signal, details),
      pausedDurationMs: () => this.pausedDurationMs(run),
      finish: (status, result) => this.finish(run, status, result)
    };
  }

  async control(params = {}, context = {}) {
    const action = String(params.action || 'status').toLowerCase();
    if (action === 'status') return this.status();

    const run = this.requireActive(params.scenarioId);
    switch (action) {
      case 'pause':
        this.requestPause(run, context, params.reason);
        break;
      case 'resume':
        this.resume(run, context, params.reason);
        break;
      case 'takeover':
        this.requestTakeover(run, context, params.reason);
        break;
      case 'release':
        this.releaseTakeover(run, context, params.reason);
        break;
      case 'cancel':
        this.cancelRun(run, context, params.reason || 'control_request');
        break;
      default:
        throw createScenarioControlError(
          'INVALID_SCENARIO_CONTROL_ACTION',
          `Unsupported scenario control action: ${action}`
        );
    }
    return this.status();
  }

  authorizeMutation(context = {}, action = 'serial mutation') {
    const run = this.active;
    if (!run) return;
    if (String(context.runId || '') === run.scenarioId) return;
    if (run.state === 'taken_over' && sameActor(run.takeoverOwner, actorIdentity(context))) return;

    throw createScenarioControlError(
      'SCENARIO_CONTROL_REQUIRED',
      `Scenario ${run.scenarioId} controls the serial session; pause and take over before ${action}`,
      {
        action,
        scenario: this.snapshotScenario(run),
        guidance: 'Call serial.scenario.control with action=takeover, wait for state=taken_over, then retry.'
      }
    );
  }

  releaseActor(context = {}, reason = 'client_disconnected') {
    const run = this.active;
    if (!run || run.state !== 'taken_over') return this.status();
    if (!sameActor(run.takeoverOwner, actorIdentity(context))) return this.status();
    this.releaseTakeover(run, { actor: 'system', actorId: context.actorId }, reason);
    return this.status();
  }

  async checkpoint(run, details = {}) {
    this.assertCurrent(run);
    throwIfCancelled(run.abortController.signal, run, details);

    if (run.requestMode) this.grantPendingControl(run, details);
    while (PAUSED_STATES.has(run.state)) {
      await this.waitForWake(run);
      this.assertCurrent(run);
      throwIfCancelled(run.abortController.signal, run, details);
      if (run.requestMode && !PAUSED_STATES.has(run.state)) {
        this.grantPendingControl(run, details);
      }
    }
  }

  stepStarted(run, details = {}) {
    this.assertCurrent(run);
    run.stepActive = true;
    run.currentStep = {
      stepId: String(details.stepId || ''),
      index: Number(details.index || 0),
      action: String(details.action || ''),
      name: String(details.name || ''),
      startedAt: Date.now()
    };
  }

  stepFinished(run, details = {}) {
    if (this.active !== run) return;
    run.stepActive = false;
    run.completedSteps = Math.max(
      run.completedSteps,
      Number(details.completedSteps || run.completedSteps)
    );
    run.currentStep = null;
  }

  async cooperativeWait(run, durationMs, signal, details = {}) {
    let remainingMs = Math.max(0, Number(durationMs) || 0);
    while (remainingMs > 0) {
      await this.checkpoint(run, details);
      const sliceMs = Math.min(50, remainingMs);
      const startedAt = Date.now();
      await abortableDelay(sliceMs, signal || run.abortController.signal);
      remainingMs -= Math.max(1, Date.now() - startedAt);
    }
  }

  pausedDurationMs(run = this.active) {
    if (!run) return 0;
    return run.totalPausedMs + (
      PAUSED_STATES.has(run.state) && run.pausedAt
        ? Math.max(0, Date.now() - run.pausedAt)
        : 0
    );
  }

  finish(run, status, result = {}) {
    if (this.active !== run) return this.lastScenario;
    if (PAUSED_STATES.has(run.state)) this.closePauseWindow(run);
    const terminalState = TERMINAL_STATES.has(status)
      ? status
      : status === 'completed'
        ? 'completed'
        : 'failed';
    run.state = terminalState;
    run.reason = String(result.reason || run.reason || '');
    run.completedSteps = Number(result.completedSteps || run.completedSteps || 0);
    run.currentStep = null;
    run.stepActive = false;
    run.requestMode = '';
    run.requestedAt = 0;
    run.takeoverOwner = null;
    run.endedAt = Number(result.endedAt || Date.now());
    this.lastScenario = this.snapshotScenario(run);
    run.unlinkExternalSignal();
    this.active = null;
    this.wake(run);
    return this.lastScenario;
  }

  requestPause(run, context, reason) {
    if (run.state === 'taken_over') {
      throw createScenarioControlError(
        'SCENARIO_TAKEOVER_ACTIVE',
        'Release manual takeover before changing the pause state',
        { scenario: this.snapshotScenario(run) }
      );
    }
    if (run.state === 'paused' || (run.state === 'pausing' && run.requestMode === 'pause')) return;

    run.requestMode = 'pause';
    run.takeoverOwner = null;
    run.requestedAt = Date.now();
    run.reason = String(reason || 'control_request').slice(0, 500);
    run.state = 'pausing';
    this.emitControl('serial.scenario.pause.requested', run, context);
    if (!run.stepActive) this.grantPendingControl(run);
  }

  resume(run, context, reason) {
    if (run.state === 'taken_over' || run.requestMode === 'takeover') {
      throw createScenarioControlError(
        'SCENARIO_TAKEOVER_ACTIVE',
        'Release manual takeover before resuming the scenario',
        { scenario: this.snapshotScenario(run) }
      );
    }
    if (run.state === 'running' && !run.requestMode) return;

    if (run.state === 'paused') this.closePauseWindow(run);
    run.requestMode = '';
    run.takeoverOwner = null;
    run.requestedAt = 0;
    run.reason = String(reason || 'control_request').slice(0, 500);
    run.state = 'running';
    this.emitControl('serial.scenario.resumed', run, context);
    this.wake(run);
  }

  requestTakeover(run, context, reason) {
    const requester = actorIdentity(context);
    if (run.state === 'taken_over') {
      if (sameActor(run.takeoverOwner, requester)) return;
      throw createScenarioControlError(
        'SCENARIO_TAKEOVER_OWNED',
        'The serial session has already been taken over by another client',
        { scenario: this.snapshotScenario(run) }
      );
    }

    run.requestMode = 'takeover';
    run.takeoverOwner = requester;
    run.requestedAt = Date.now();
    run.reason = String(reason || 'manual_debug').slice(0, 500);
    if (run.state !== 'paused') run.state = 'takeover_pending';
    this.emitControl('serial.scenario.takeover.requested', run, context);
    if (!run.stepActive) this.grantPendingControl(run);
  }

  releaseTakeover(run, context, reason) {
    if (run.state !== 'taken_over' && run.requestMode !== 'takeover') {
      throw createScenarioControlError(
        'SCENARIO_NOT_TAKEN_OVER',
        'The active scenario is not in manual takeover mode',
        { scenario: this.snapshotScenario(run) }
      );
    }

    if (run.state === 'taken_over') this.closePauseWindow(run);
    run.takeoverOwner = null;
    run.requestMode = 'pause';
    run.requestedAt = Date.now();
    run.reason = String(reason || 'manual_debug_complete').slice(0, 500);
    run.state = 'paused';
    run.pausedAt = Date.now();
    this.emitControl('serial.scenario.takeover.released', run, context);
  }

  cancelRun(run, context, reason) {
    if (this.active !== run || run.abortController.signal.aborted) return;
    if (PAUSED_STATES.has(run.state)) this.closePauseWindow(run);
    run.state = 'cancelling';
    run.requestMode = '';
    run.requestedAt = 0;
    run.reason = String(reason || 'control_request').slice(0, 500);
    this.emitControl('serial.scenario.cancel.requested', run, context);
    run.abortController.abort();
    this.wake(run);
  }

  grantPendingControl(run, details = {}) {
    if (!run.requestMode) return;
    if (!run.pausedAt) run.pausedAt = Date.now();

    if (run.requestMode === 'takeover') {
      run.state = 'taken_over';
      this.emitControl('serial.scenario.takeover.granted', run, run.takeoverOwner || run.owner, details);
      return;
    }

    run.state = 'paused';
    this.emitControl('serial.scenario.paused', run, run.owner, details);
  }

  closePauseWindow(run) {
    if (run.pausedAt) {
      run.totalPausedMs += Math.max(0, Date.now() - run.pausedAt);
      run.pausedAt = 0;
    }
  }

  waitForWake(run) {
    return new Promise(resolve => {
      const waiter = () => {
        run.waiters.delete(waiter);
        resolve();
      };
      run.waiters.add(waiter);
      if (run.abortController.signal.aborted || !PAUSED_STATES.has(run.state)) waiter();
    });
  }

  wake(run) {
    for (const waiter of [...run.waiters]) waiter();
  }

  requireActive(scenarioId) {
    const run = this.active;
    if (!run) {
      throw createScenarioControlError('NO_ACTIVE_SCENARIO', 'There is no active serial scenario', {
        lastScenario: this.lastScenario
      });
    }
    if (scenarioId && String(scenarioId) !== run.scenarioId) {
      throw createScenarioControlError(
        'SCENARIO_ID_MISMATCH',
        `Active scenario is ${run.scenarioId}, not ${scenarioId}`,
        { scenario: this.snapshotScenario(run) }
      );
    }
    return run;
  }

  assertCurrent(run) {
    if (this.active === run) return;
    throw createScenarioControlError(
      'SCENARIO_NOT_ACTIVE',
      `Scenario ${run.scenarioId} is no longer active`
    );
  }

  snapshotScenario(run) {
    return {
      scenarioId: run.scenarioId,
      name: run.name,
      state: run.state,
      owner: run.owner,
      takeoverOwner: run.takeoverOwner,
      reason: run.reason,
      stepCount: run.stepCount,
      completedSteps: run.completedSteps,
      currentStep: run.currentStep,
      startedAt: run.startedAt,
      ...(run.endedAt ? { endedAt: run.endedAt } : {}),
      pausedAt: run.pausedAt,
      pausedDurationMs: this.pausedDurationMs(run),
      requestedAt: run.requestedAt,
      controlPending: run.requestMode || null
    };
  }

  emitControl(event, run, context = {}, details = {}) {
    if (!this.emit) return;
    this.emit(event, {
      scenarioId: run.scenarioId,
      name: run.name,
      state: run.state,
      reason: run.reason,
      scenario: this.snapshotScenario(run),
      ...details,
      timestamp: Date.now()
    }, context);
  }
}

function actorIdentity(context = {}) {
  return {
    actor: String(context.actor || 'unknown'),
    actorId: String(context.actorId || '')
  };
}

function sameActor(left, right) {
  if (!left || !right) return false;
  if (left.actorId || right.actorId) {
    return Boolean(left.actorId) && left.actorId === right.actorId && left.actor === right.actor;
  }
  return left.actor === right.actor;
}

function createScenarioId() {
  if (typeof crypto.randomUUID === 'function') return `scenario-${crypto.randomUUID()}`;
  return `scenario-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function createScenarioControlError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function throwIfCancelled(signal, run, details = {}) {
  if (!signal?.aborted) return;
  throw createScenarioControlError(
    'OPERATION_CANCELLED',
    'Serial scenario was cancelled',
    {
      scenarioId: run.scenarioId,
      reason: run.reason,
      ...details
    }
  );
}

function abortableDelay(durationMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      reject(createScenarioControlError('OPERATION_CANCELLED', 'Serial scenario was cancelled'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', abort);
      resolve();
    }, durationMs);
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

module.exports = {
  ScenarioController,
  createScenarioControlError
};
