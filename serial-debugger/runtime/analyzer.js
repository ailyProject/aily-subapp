'use strict';

const crypto = require('crypto');
const {
  DEFAULT_RESULT_MAX_BYTES,
  jsonByteLength,
  utf8Preview
} = require('./result-budget');

function analyzeSerialEvents(events = [], options = {}) {
  const analysisId = String(options.analysisId || createAnalysisId());
  const maxFindings = numberInRange(options.maxFindings, 20, 1, 50);
  const ordered = [...events].sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0));
  const rxEvents = ordered.filter(event => event.event === 'serial.rx');
  const txEvents = ordered.filter(event => event.event === 'serial.tx');
  const firstTimestamp = Number(ordered[0]?.timestamp || 0);
  const lastTimestamp = Number(ordered.at(-1)?.timestamp || firstTimestamp);
  const durationMs = Math.max(0, lastTimestamp - firstTimestamp);
  const rxBytes = rxEvents.reduce((sum, event) => sum + Number(event.data?.byteLength || 0), 0);
  const txBytes = txEvents.reduce((sum, event) => sum + Number(event.data?.byteLength || 0), 0);
  const findings = [];

  addGroupedEventFinding(findings, ordered, {
    code: 'SERIAL_RUNTIME_ERROR',
    event: 'serial.error',
    severity: 'error',
    title: 'Serial Runtime reported errors',
    message: count => `${count} serial error event(s) were recorded.`,
    recommendation: 'Inspect the error messages, port ownership, cable, driver, and device power.'
  });

  const timeoutEvents = ordered.filter(event =>
    event.event === 'serial.transaction.failed'
    && String(event.data?.errorCode || '').toUpperCase() === 'EXPECT_TIMEOUT'
  );
  if (timeoutEvents.length) {
    findings.push(createFinding({
      code: 'EXPECT_TIMEOUT',
      severity: 'warning',
      title: 'Device responses timed out',
      message: `${timeoutEvents.length} transaction(s) did not match the expected response.`,
      recommendation: 'Verify baud/framing, command terminators, expected pattern, device reset state, and RX wiring.',
      events: timeoutEvents
    }));
  }

  const failedTransactions = ordered.filter(event =>
    event.event === 'serial.transaction.failed'
    && String(event.data?.errorCode || '').toUpperCase() !== 'EXPECT_TIMEOUT'
  );
  if (failedTransactions.length) {
    findings.push(createFinding({
      code: 'TRANSACTION_FAILED',
      severity: 'error',
      title: 'Serial transactions failed',
      message: `${failedTransactions.length} transaction(s) failed before completing.`,
      recommendation: 'Inspect each errorCode and correlate it with port state and the surrounding Journal events.',
      events: failedTransactions
    }));
  }

  const failedScenarioSteps = ordered.filter(event => event.event === 'serial.scenario.step.failed');
  if (failedScenarioSteps.length) {
    findings.push(createFinding({
      code: 'SCENARIO_STEP_FAILED',
      severity: 'warning',
      title: 'Automated scenario steps failed',
      message: `${failedScenarioSteps.length} scenario step(s) failed.`,
      recommendation: 'Review the first failed step before rerunning later dependent steps.',
      events: failedScenarioSteps
    }));
  }

  if (txEvents.length && !rxEvents.length) {
    findings.push(createFinding({
      code: 'NO_RX_AFTER_TX',
      severity: 'warning',
      title: 'Data was transmitted but no RX was observed',
      message: `${txEvents.length} TX event(s) produced no captured RX data in the selected range.`,
      recommendation: 'Check MCU TX to adapter RX, common ground, baud/framing, command terminator, and firmware logging.',
      events: txEvents
    }));
  }

  const textMetrics = analyzeTextQuality(rxEvents);
  if (textMetrics.replacementCharacters >= 3 || textMetrics.suspiciousControlRatio >= 0.02) {
    findings.push(createFinding({
      code: 'POSSIBLE_GARBLED_DATA',
      severity: 'warning',
      title: 'RX text may be garbled or use the wrong framing',
      message: `${textMetrics.replacementCharacters} replacement character(s); ${(textMetrics.suspiciousControlRatio * 100).toFixed(1)}% suspicious control characters.`,
      recommendation: 'Verify baud rate first, then data bits, parity, stop bits, clock accuracy, and whether the stream is binary.',
      events: textMetrics.events
    }));
  }

  const faultMatches = collectKeywordEvents(rxEvents, /\b(?:panic|hardfault|assert(?:ion)?|watchdog|fatal|exception)\b/i);
  if (faultMatches.length) {
    findings.push(createFinding({
      code: 'FIRMWARE_FAULT_TEXT',
      severity: 'error',
      title: 'Firmware fault keywords were observed',
      message: `${faultMatches.length} RX event(s) contain panic, fault, assert, watchdog, fatal, or exception markers.`,
      recommendation: 'Capture the surrounding stack trace/reset reason and correlate it with the command that preceded the fault.',
      events: faultMatches,
      includeSnippets: true
    }));
  }

  const resetMatches = collectKeywordEvents(rxEvents, /\b(?:boot(?:ing)?|reboot|reset reason|rst:|power[- ]?on reset)\b/i);
  if (resetMatches.length >= 3) {
    findings.push(createFinding({
      code: 'POSSIBLE_RESET_LOOP',
      severity: 'warning',
      title: 'Repeated boot/reset messages suggest a reset loop',
      message: `${resetMatches.length} boot or reset markers were observed in the selected range.`,
      recommendation: 'Inspect reset reason, watchdog, brownout, DTR/RTS behavior, boot pins, and power stability.',
      events: resetMatches,
      includeSnippets: true
    }));
  }

  const rxRate = durationMs > 0 ? rxBytes / (durationMs / 1000) : rxBytes;
  if (rxBytes >= 1024 * 1024 && rxRate >= 256 * 1024) {
    findings.push(createFinding({
      code: 'HIGH_RATE_RX',
      severity: 'info',
      title: 'High-rate serial output detected',
      message: `${formatBytes(rxBytes)} RX at approximately ${formatBytes(rxRate)}/s.`,
      recommendation: 'Use Journal/artifact search and bounded reads instead of returning the entire stream to the Agent.',
      events: [rxEvents[0], rxEvents.at(-1)].filter(Boolean)
    }));
  }

  const closedEvents = ordered.filter(event => event.event === 'serial.closed');
  if (closedEvents.length && ordered.some(event => event.event === 'serial.transaction.started')) {
    findings.push(createFinding({
      code: 'SESSION_CLOSED_DURING_DEBUG',
      severity: 'info',
      title: 'Serial session closed during the analyzed workflow',
      message: `${closedEvents.length} close event(s) were recorded.`,
      recommendation: 'Confirm whether closure was intentional; otherwise inspect USB stability and competing port owners.',
      events: closedEvents
    }));
  }

  const limitedFindings = findings
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))
    .slice(0, maxFindings);
  const severityCounts = {
    error: limitedFindings.filter(finding => finding.severity === 'error').length,
    warning: limitedFindings.filter(finding => finding.severity === 'warning').length,
    info: limitedFindings.filter(finding => finding.severity === 'info').length
  };
  const verdict = severityCounts.error
    ? 'errors-detected'
    : severityCounts.warning
      ? 'attention-needed'
      : ordered.length
        ? 'no-obvious-issues'
        : 'insufficient-data';

  return boundAnalysisResult({
    analysisId,
    verdict,
    eventCount: ordered.length,
    inputTruncated: options.inputTruncated === true,
    startSeq: Number(ordered[0]?.seq || 0),
    endSeq: Number(ordered.at(-1)?.seq || 0),
    firstTimestamp,
    lastTimestamp,
    durationMs,
    metrics: {
      rxEvents: rxEvents.length,
      txEvents: txEvents.length,
      rxBytes,
      txBytes,
      rxBytesPerSecond: Math.round(rxRate),
      replacementCharacters: textMetrics.replacementCharacters,
      suspiciousControlRatio: Number(textMetrics.suspiciousControlRatio.toFixed(4))
    },
    severityCounts,
    findings: limitedFindings
  });
}

function analyzeTextQuality(rxEvents) {
  let characters = 0;
  let replacements = 0;
  let suspiciousControls = 0;
  const evidence = [];
  for (const event of rxEvents) {
    const text = String(event.data?.text || '');
    characters += text.length;
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const controlCount = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) || []).length;
    replacements += replacementCount;
    suspiciousControls += controlCount;
    if ((replacementCount || controlCount) && evidence.length < 8) evidence.push(event);
  }
  return {
    replacementCharacters: replacements,
    suspiciousControlRatio: characters ? suspiciousControls / characters : 0,
    events: evidence
  };
}

function collectKeywordEvents(events, pattern) {
  return events.filter(event => pattern.test(String(event.data?.text || '')));
}

function addGroupedEventFinding(findings, events, rule) {
  const matches = events.filter(event => event.event === rule.event);
  if (!matches.length) return;
  findings.push(createFinding({
    code: rule.code,
    severity: rule.severity,
    title: rule.title,
    message: rule.message(matches.length),
    recommendation: rule.recommendation,
    events: matches,
    includeSnippets: true
  }));
}

function createFinding(options) {
  const events = options.events.filter(Boolean);
  const finding = {
    code: options.code,
    severity: options.severity,
    title: options.title,
    message: options.message,
    recommendation: options.recommendation,
    evidence: {
      seqs: events.slice(0, 8).map(event => Number(event.seq || 0)),
      startSeq: Number(events[0]?.seq || 0),
      endSeq: Number(events.at(-1)?.seq || 0)
    }
  };
  if (options.includeSnippets) {
    finding.evidence.snippets = events.slice(0, 3).map(event => {
      const value = event.data?.message || event.data?.text || event.data?.error || '';
      return utf8Preview(value, 256).value;
    });
  }
  return finding;
}

function boundAnalysisResult(result) {
  if (jsonByteLength(result) <= DEFAULT_RESULT_MAX_BYTES) return result;
  const compact = { ...result, findings: [...result.findings], truncated: true };
  while (jsonByteLength(compact) > DEFAULT_RESULT_MAX_BYTES && compact.findings.length) {
    compact.findings.pop();
  }
  return compact;
}

function severityRank(severity) {
  return severity === 'error' ? 3 : severity === 'warning' ? 2 : 1;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${Math.round(bytes)} B`;
}

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function createAnalysisId() {
  if (typeof crypto.randomUUID === 'function') return `analysis-${crypto.randomUUID()}`;
  return `analysis-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  analyzeSerialEvents
};
