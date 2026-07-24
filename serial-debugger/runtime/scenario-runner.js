'use strict';

const crypto = require('crypto');
const {
  DEFAULT_RESULT_MAX_BYTES,
  jsonByteLength,
  summarizeCapture,
  summarizeChunk,
  summarizeErrorDetails
} = require('./result-budget');

const MAX_SCENARIO_STEPS = 50;
const DEFAULT_SCENARIO_TIMEOUT_MS = 120000;
const MAX_SCENARIO_TIMEOUT_MS = 600000;

async function runSerialScenario(runtime, params = {}, context = {}, signal) {
  const steps = Array.isArray(params.steps) ? params.steps : [];
  if (!steps.length) throw createScenarioError('INVALID_SCENARIO', 'Scenario requires at least one step');
  if (steps.length > MAX_SCENARIO_STEPS) {
    throw createScenarioError(
      'INVALID_SCENARIO',
      `Scenario exceeds the ${MAX_SCENARIO_STEPS}-step limit`
    );
  }
  const scenarioId = String(params.scenarioId || createScenarioId());
  const name = String(params.name || 'Serial scenario').slice(0, 200);
  const stopOnFailure = params.stopOnFailure !== false;
  const timeoutMs = numberInRange(
    params.timeoutMs,
    DEFAULT_SCENARIO_TIMEOUT_MS,
    1000,
    MAX_SCENARIO_TIMEOUT_MS
  );
  const startedAt = Date.now();
  const scenarioControl = runtime.scenarioControl || null;
  const deadline = () => startedAt + timeoutMs + Number(
    scenarioControl?.pausedDurationMs?.() || 0
  );
  const startSeq = runtime.lastSeq();
  const scenarioContext = {
    actor: 'agent',
    ...context,
    runId: scenarioId
  };
  const results = [];
  let failures = 0;

  runtime.emit('serial.scenario.started', {
    scenarioId,
    name,
    stepCount: steps.length,
    stopOnFailure,
    timeoutMs,
    timestamp: startedAt
  }, scenarioContext);

  throwIfScenarioCancelled(runtime, signal, scenarioContext, {
    scenarioId,
    name,
    phase: 'start',
    stepCount: steps.length,
    completedSteps: 0,
    durationMs: Date.now() - startedAt
  });
  if (params.connect && !runtime.status().connected) {
    await runtime.connect(params.connect, scenarioContext);
    if (signal?.aborted) {
      await runtime.disconnect?.({ actor: 'system', reason: 'cancelled' }).catch(() => undefined);
    }
    throwIfScenarioCancelled(runtime, signal, scenarioContext, {
      scenarioId,
      name,
      phase: 'connect',
      stepCount: steps.length,
      completedSteps: 0,
      durationMs: Date.now() - startedAt
    });
  }
  if (!runtime.status().connected) {
    const error = createScenarioError(
      'PORT_DISCONNECTED',
      'Serial scenario requires an open serial session'
    );
    runtime.emit('serial.scenario.failed', {
      scenarioId,
      name,
      completedSteps: 0,
      failedSteps: 1,
      error: error.message,
      errorCode: error.code,
      timestamp: Date.now()
    }, scenarioContext);
    throw error;
  }

  await checkpointScenarioControl(runtime, scenarioControl, signal, scenarioContext, {
    scenarioId,
    name,
    phase: 'ready',
    stepCount: steps.length,
    completedSteps: 0,
    durationMs: Date.now() - startedAt
  });

  for (let index = 0; index < steps.length; index += 1) {
    const step = normalizeStep(steps[index], index);
    const stepContext = {
      ...scenarioContext,
      stepId: step.stepId
    };
    await checkpointScenarioControl(runtime, scenarioControl, signal, scenarioContext, {
      scenarioId,
      name,
      stepId: step.stepId,
      stepCount: steps.length,
      completedSteps: results.filter(item => item.status === 'completed').length,
      durationMs: Date.now() - startedAt
    });
    throwIfScenarioCancelled(runtime, signal, scenarioContext, {
      scenarioId,
      name,
      stepId: step.stepId,
      stepCount: steps.length,
      completedSteps: results.filter(item => item.status === 'completed').length,
      durationMs: Date.now() - startedAt
    });
    if (Date.now() >= deadline()) {
      const timeout = createScenarioError(
        'SCENARIO_TIMEOUT',
        `Scenario exceeded its ${timeoutMs} ms timeout`,
        { scenarioId, stepId: step.stepId, timeoutMs }
      );
      results.push(failedStepSummary(step, timeout, 0));
      failures += 1;
      break;
    }

    const stepStartedAt = Date.now();
    runtime.emit('serial.scenario.step.started', {
      scenarioId,
      stepId: step.stepId,
      index,
      action: step.action,
      name: step.name,
      timestamp: stepStartedAt
    }, stepContext);
    scenarioControl?.stepStarted?.({
      scenarioId,
      stepId: step.stepId,
      index,
      action: step.action,
      name: step.name
    });

    try {
      const rawResult = await executeStep(
        runtime,
        step,
        stepContext,
        deadline(),
        signal,
        scenarioControl
      );
      const summary = successfulStepSummary(step, rawResult, Date.now() - stepStartedAt);
      results.push(summary);
      runtime.emit('serial.scenario.step.completed', {
        scenarioId,
        ...summary,
        timestamp: Date.now()
      }, stepContext);
    } catch (error) {
      error.details = summarizeErrorDetails(error?.details, { previewBytes: 512 });
      const summary = failedStepSummary(step, error, Date.now() - stepStartedAt);
      results.push(summary);
      failures += 1;
      runtime.emit('serial.scenario.step.failed', {
        scenarioId,
        ...summary,
        timestamp: Date.now()
      }, stepContext);
      if (error?.code === 'OPERATION_CANCELLED') {
        runtime.emit('serial.scenario.cancelled', {
          scenarioId,
          name,
          completedSteps: results.filter(item => item.status === 'completed').length,
          failedSteps: failures,
          stepId: step.stepId,
          stepCount: steps.length,
          durationMs: Date.now() - startedAt,
          timestamp: Date.now()
        }, scenarioContext);
        throw error;
      }
      if (stopOnFailure) break;
    } finally {
      scenarioControl?.stepFinished?.({
        scenarioId,
        stepId: step.stepId,
        completedSteps: results.filter(item => item.status === 'completed').length
      });
    }
  }

  const endedAt = Date.now();
  const status = failures ? 'failed' : 'completed';
  const endSeq = runtime.lastSeq();
  const pausedDurationMs = Number(scenarioControl?.pausedDurationMs?.() || 0);
  runtime.emit(`serial.scenario.${status}`, {
    scenarioId,
    name,
    status,
    stepCount: steps.length,
    completedSteps: results.filter(step => step.status === 'completed').length,
    failedSteps: failures,
    durationMs: endedAt - startedAt,
    pausedDurationMs,
    activeDurationMs: Math.max(0, endedAt - startedAt - pausedDurationMs),
    startSeq,
    endSeq,
    timestamp: endedAt
  }, scenarioContext);

  return boundScenarioResult({
    scenarioId,
    name,
    status,
    stopOnFailure,
    stepCount: steps.length,
    completedSteps: results.filter(step => step.status === 'completed').length,
    failedSteps: failures,
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    pausedDurationMs,
    activeDurationMs: Math.max(0, endedAt - startedAt - pausedDurationMs),
    startSeq,
    endSeq,
    steps: results,
    ...(runtime.evidence ? { evidence: runtime.evidence(startSeq, endSeq) } : {})
  });
}

async function executeStep(runtime, step, context, deadline, signal, scenarioControl) {
  throwIfCancelled(signal, { stepId: step.stepId });
  switch (step.action) {
    case 'transact':
      return await runtime.transact({
        ...step.options,
        timeoutMs: boundedRemainingTimeout(step.options.timeoutMs, deadline)
      }, context, signal);
    case 'send':
      return await runtime.send(step.options.send || step.options, context);
    case 'capture':
      return await runtime.capture({
        ...step.options,
        durationMs: Math.min(
          numberInRange(step.options.durationMs, 1000, 1, 120000),
          Math.max(1, deadline - Date.now())
        ),
      }, signal);
    case 'signal':
      if (step.options.pulse === true || step.options.durationMs !== undefined) {
        return await runtime.pulseSignal(step.options, context, signal);
      }
      return await runtime.setSignals(step.options, context);
    case 'wait': {
      const durationMs = Math.min(
        numberInRange(step.options.durationMs ?? step.options.waitMs, 100, 1, 30000),
        Math.max(1, deadline - Date.now())
      );
      if (scenarioControl?.wait) {
        await scenarioControl.wait(durationMs, signal, {
          stepId: step.stepId,
          action: step.action
        });
      } else {
        await delay(durationMs, signal);
      }
      return { durationMs };
    }
    default:
      throw createScenarioError('INVALID_SCENARIO_STEP', `Unsupported scenario action: ${step.action}`, {
        stepId: step.stepId,
        action: step.action
      });
  }
}

function normalizeStep(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw createScenarioError('INVALID_SCENARIO_STEP', `Scenario step ${index + 1} must be an object`);
  }
  const options = { ...value };
  const action = String(
    options.action
    || options.type
    || (options.send && options.expect ? 'transact' : options.send ? 'send' : '')
  ).toLowerCase();
  delete options.action;
  delete options.type;
  delete options.stepId;
  delete options.name;
  return {
    stepId: String(value.stepId || `step-${index + 1}`).slice(0, 100),
    name: String(value.name || action || `Step ${index + 1}`).slice(0, 200),
    action,
    options
  };
}

function successfulStepSummary(step, result = {}, durationMs) {
  const capture = result.capture ? summarizeCapture(result.capture, { previewBytes: 256 }) : null;
  return {
    stepId: step.stepId,
    name: step.name,
    action: step.action,
    status: 'completed',
    durationMs,
    ...(result.matched !== undefined ? { matched: result.matched === true } : {}),
    ...(result.reason ? { reason: String(result.reason) } : {}),
    ...(result.startSeq ? { startSeq: Number(result.startSeq) } : {}),
    ...(result.endSeq ? { endSeq: Number(result.endSeq) } : {}),
    ...(capture ? {
      byteLength: capture.byteLength,
      preview: capture.text,
      truncated: capture.truncated
    } : {}),
    ...(result.byteLength !== undefined && !capture
      ? summarizeChunk(result, { previewBytes: 256 })
      : {}),
    ...evidenceSummary(result.evidence)
  };
}

function failedStepSummary(step, error, durationMs) {
  return {
    stepId: step.stepId,
    name: step.name,
    action: step.action,
    status: 'failed',
    durationMs,
    error: error?.message || String(error),
    errorCode: String(error?.code || 'SCENARIO_STEP_FAILED'),
    ...evidenceSummary(error?.details?.evidence)
  };
}

function evidenceSummary(evidence) {
  if (!evidence) return {};
  return {
    evidence: {
      startSeq: Number(evidence.startSeq || 0),
      endSeq: Number(evidence.endSeq || 0),
      artifactIds: Array.isArray(evidence.artifacts)
        ? evidence.artifacts.slice(0, 8).map(artifact => String(artifact.artifactId || ''))
        : []
    }
  };
}

function boundScenarioResult(result) {
  if (jsonByteLength(result) <= DEFAULT_RESULT_MAX_BYTES) return result;
  const compact = {
    ...result,
    steps: result.steps.map(step => {
      const { preview: _preview, ...summary } = step;
      return summary;
    }),
    truncated: true
  };
  while (jsonByteLength(compact) > DEFAULT_RESULT_MAX_BYTES && compact.steps.length) {
    compact.steps.pop();
    compact.returnedStepCount = compact.steps.length;
  }
  return compact;
}

function boundedRemainingTimeout(requestedTimeout, deadline) {
  return Math.min(
    numberInRange(requestedTimeout, 3000, 1, 120000),
    Math.max(1, deadline - Date.now())
  );
}

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function createScenarioId() {
  if (typeof crypto.randomUUID === 'function') return `scenario-${crypto.randomUUID()}`;
  return `scenario-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

function createScenarioError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function throwIfCancelled(signal, details = {}) {
  if (!signal?.aborted) return;
  throw createScenarioError('OPERATION_CANCELLED', 'Serial scenario was cancelled', details);
}

function throwIfScenarioCancelled(runtime, signal, context, details) {
  if (!signal?.aborted) return;
  runtime.emit('serial.scenario.cancelled', {
    ...details,
    timestamp: Date.now()
  }, context);
  throwIfCancelled(signal, details);
}

async function checkpointScenarioControl(runtime, scenarioControl, signal, context, details) {
  if (!scenarioControl?.checkpoint) return;
  try {
    await scenarioControl.checkpoint(details);
  } catch (error) {
    if (error?.code === 'OPERATION_CANCELLED' || signal?.aborted) {
      throwIfScenarioCancelled(runtime, signal, context, details);
    }
    throw error;
  }
}

function delay(durationMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      reject(createScenarioError('OPERATION_CANCELLED', 'Serial scenario was cancelled'));
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
  MAX_SCENARIO_STEPS,
  runSerialScenario
};
