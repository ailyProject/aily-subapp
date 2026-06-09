<script>
  import { onMount, tick } from 'svelte';

  const query = new URLSearchParams(window.location.search);
  const token = query.get('token') || '';
  const storageKey = 'aily.serial-debugger.settings';
  const baudRates = ['4800', '9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600', '1000000', '2000000', '3000000', '4000000'];
  const dataBitOptions = ['5', '6', '7', '8'];
  const stopBitOptions = ['1', '1.5', '2'];
  const parityOptions = ['none', 'odd', 'even', 'mark', 'space'];
  const flowControlOptions = ['none', 'hardware', 'software'];
  const quickSends = [
    { label: 'DTR', type: 'signal', signal: 'dtr' },
    { label: 'RTS', type: 'signal', signal: 'rts' },
    { label: 'TEXT_SAMPLE', type: 'text', data: 'This is aily blockly' },
    { label: 'HEX_SAMPLE', type: 'hex', data: 'FF FF A1 A2 A3 A4 A5' }
  ];

  let hostRemote = null;
  let hostContext = {
    lang: normalizeLang(query.get('lang') || navigator.language || 'en'),
    theme: normalizeTheme(query.get('theme')),
    platform: 'browser'
  };
  let i18nLang = 'en';
  let bundle = {};
  let t = (key, fallback = key) => fallback;
  let backendWs = null;
  let requestSeq = 0;
  let rowSeq = 0;
  const pendingRequests = new Map();

  let backendStatus = 'connecting';
  let backendPid = 0;
  let connected = false;
  let connectLoading = false;
  let sendLoading = false;
  let ports = [];
  let currentPort = '';
  let baudRate = '115200';
  let dataBits = '8';
  let stopBits = '1';
  let parity = 'none';
  let flowControl = 'none';
  let showAdvanced = false;
  let rows = [];
  let searchKeyword = '';
  let inputValue = '';
  let rxBytes = 0;
  let txBytes = 0;
  let signals = {
    dtr: false,
    rts: false,
    brk: false
  };
  let viewMode = {
    showHex: false,
    autoWrap: true,
    autoScroll: true,
    showTimestamp: true,
    showCtrlChar: false
  };
  let inputMode = {
    hexMode: false,
    sendByEnter: false,
    endR: true,
    endN: true
  };

  function normalizeLang(lang) {
    const normalized = String(lang || 'en').toLowerCase().replace(/-/g, '_');
    if (normalized.startsWith('zh_cn') || normalized === 'zh') return 'zh_cn';
    if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
    return normalized || 'en';
  }

  function normalizeTheme(theme) {
    return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
  }

  $: t = (key, fallback = key) => bundle[key] || fallback;

  function applyTheme(theme) {
    const normalized = normalizeTheme(theme);
    document.documentElement.dataset.theme = normalized;
    document.documentElement.style.colorScheme = normalized;

    let themeLink = document.getElementById('theme-style');
    if (!themeLink) {
      themeLink = document.createElement('link');
      themeLink.id = 'theme-style';
      themeLink.rel = 'stylesheet';
      document.head.appendChild(themeLink);
    }

    const href = `./${normalized}.css`;
    if (themeLink.getAttribute('href') !== href) {
      themeLink.setAttribute('href', href);
    }

    return normalized;
  }

  async function loadI18n(lang) {
    const normalized = normalizeLang(lang);
    const candidates = normalized === 'en' ? ['en'] : [normalized, 'en'];

    for (const candidate of candidates) {
      try {
        const response = await fetch(`/i18n/${candidate}.json`, { cache: 'no-store' });
        if (!response.ok) continue;
        const data = await response.json();
        i18nLang = candidate;
        bundle = data.SERIAL_DEBUGGER || {};
        document.title = t('TITLE', 'Serial Debugger');
        return;
      } catch {
        // Try the fallback language.
      }
    }
  }

  async function applyHostContext(context = {}) {
    const lang = normalizeLang(context.lang || hostContext.lang);
    const theme = normalizeTheme(context.theme || hostContext.theme);
    hostContext = {
      ...hostContext,
      ...context,
      lang,
      theme
    };
    document.documentElement.lang = lang;
    applyTheme(theme);
    await loadI18n(lang);
  }

  function connectHost() {
    if (!window.Penpal || !window.parent || window.parent === window) return;

    const messenger = new window.Penpal.WindowMessenger({
      remoteWindow: window.parent,
      allowedOrigins: ['*']
    });

    const connection = window.Penpal.connect({
      messenger,
      methods: {
        setHostContext(context = {}) {
          void applyHostContext(context);
          return { ok: true };
        },
        focusTool() {
          window.focus();
          return { ok: true };
        },
        beforeClose() {
          return {
            canClose: !connected,
            connected
          };
        }
      }
    });

    connection.promise
      .then(async remote => {
        hostRemote = remote;
        if (typeof remote.getHostContext === 'function') {
          const context = await remote.getHostContext();
          if (context) await applyHostContext(context);
        }
        if (backendStatus === 'ready') notifyHostReady();
      })
      .catch(error => {
        pushSystemRow('error', 'HOST_CONNECTION_FAILED', error.message || String(error));
      });
  }

  function notifyHostReady() {
    if (!hostRemote || typeof hostRemote.childReady !== 'function') return;
    void hostRemote.childReady({
      wsConnected: Boolean(backendWs && backendWs.readyState === WebSocket.OPEN),
      backendStatus,
      adapterState: connected ? 'connected' : 'idle',
      pid: backendPid
    });
  }

  function notifyHostError(error) {
    if (!hostRemote || typeof hostRemote.childError !== 'function') return;
    void hostRemote.childError({
      message: error?.message || String(error || 'Unknown serial debugger error')
    });
  }

  function now() {
    return new Date().toLocaleTimeString();
  }

  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      if (saved.currentPort !== undefined) currentPort = String(saved.currentPort);
      if (saved.baudRate !== undefined) baudRate = String(saved.baudRate);
      if (saved.dataBits !== undefined) dataBits = String(saved.dataBits);
      if (saved.stopBits !== undefined) stopBits = String(saved.stopBits);
      if (saved.parity !== undefined) parity = String(saved.parity);
      if (saved.flowControl !== undefined) flowControl = String(saved.flowControl);
      if (saved.viewMode) viewMode = { ...viewMode, ...saved.viewMode };
      if (saved.inputMode) inputMode = { ...inputMode, ...saved.inputMode };
    } catch {
      // Ignore corrupted local settings.
    }
  }

  function saveSettings() {
    const payload = {
      currentPort,
      baudRate,
      dataBits,
      stopBits,
      parity,
      flowControl,
      viewMode,
      inputMode
    };
    localStorage.setItem(storageKey, JSON.stringify(payload));
  }

  function selectedPortLabel() {
    if (currentPort) return currentPort;
    return ports.length ? t('SELECT_PORT', 'Select port') : t('NO_PORTS', 'No serial ports');
  }

  function portLabel(port) {
    return port.name && port.name !== port.path ? `${port.path} - ${port.name}` : port.path;
  }

  function visibleText(row) {
    if (row.kind === 'system') return row.detail || row.label || '';
    if (viewMode.showHex) return row.hex || '';
    let value = row.text || '';
    if (viewMode.showCtrlChar) {
      value = value
        .replace(/\r\n/g, '\\r\\n\n')
        .replace(/\n/g, '\\n\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/\f/g, '\\f')
        .replace(/\v/g, '\\v')
        .replace(/\0/g, '\\0');
    }
    return value;
  }

  function rowMatches(row) {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return false;
    return `${row.dir} ${row.label || ''} ${visibleText(row)}`.toLowerCase().includes(keyword);
  }

  function request(method, params = {}, timeoutMs = 15000) {
    if (!backendWs || backendWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not connected'));
    }

    const id = ++requestSeq;
    const payload = JSON.stringify({ id, method, params });
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timeout });
    });

    backendWs.send(payload);
    return response;
  }

  function handleBackendMessage(raw) {
    const message = JSON.parse(raw);
    if (typeof message.id === 'number') {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingRequests.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'Serial debugger request failed'));
      return;
    }

    if (message.event === 'ready') {
      backendStatus = 'ready';
      backendPid = Number(message.data?.pid) || 0;
      applyStatus(message.data?.state || {});
      notifyHostReady();
      void refreshPorts();
      return;
    }

    if (message.event === 'serial.rx') {
      applyTraffic('RX', message.data || {});
      return;
    }

    if (message.event === 'serial.tx') {
      applyTraffic('TX', message.data || {});
      return;
    }

    if (message.event === 'serial.opened') {
      applyStatus(message.data || {});
      pushSystemRow('info', 'PORT_OPENED', currentPort);
      return;
    }

    if (message.event === 'serial.closed') {
      applyStatus(message.data || {});
      pushSystemRow('info', 'PORT_CLOSED');
      return;
    }

    if (message.event === 'serial.signal') {
      if (message.data?.signals) signals = { ...signals, ...message.data.signals };
      pushSystemRow('info', 'SIGNAL_CHANGED', signalSummary());
      return;
    }

    if (message.event === 'serial.error' || message.event === 'error') {
      pushSystemRow('error', 'ERROR', message.data?.message || 'Serial error');
      notifyHostError(new Error(message.data?.message || 'Serial error'));
    }
  }

  function applyTraffic(dir, data) {
    const byteLength = Number(data.byteLength) || 0;
    if (dir === 'RX') rxBytes = Number(data.rxBytes) || rxBytes + byteLength;
    if (dir === 'TX') txBytes = Number(data.txBytes) || txBytes + byteLength;
    rows = trimRows([
      ...rows,
      {
        id: ++rowSeq,
        kind: 'data',
        dir,
        time: new Date(Number(data.timestamp) || Date.now()).toLocaleTimeString(),
        base64: data.base64 || '',
        hex: data.hex || '',
        text: data.text || '',
        byteLength
      }
    ]);
    void scrollToBottom();
  }

  function pushSystemRow(level, label, detail = '') {
    rows = trimRows([
      ...rows,
      {
        id: ++rowSeq,
        kind: 'system',
        dir: level === 'error' ? 'ERR' : 'SYS',
        time: now(),
        label,
        detail: detail ? `${t(label, label)}: ${detail}` : t(label, label)
      }
    ]);
    void scrollToBottom();
  }

  function trimRows(nextRows) {
    if (nextRows.length > 4000) {
      return nextRows.slice(nextRows.length - 3500);
    }
    return nextRows;
  }

  async function scrollToBottom() {
    if (!viewMode.autoScroll) return;
    await tick();
    const list = document.getElementById('data-list');
    if (list) list.scrollTop = list.scrollHeight;
  }

  function applyStatus(status = {}) {
    connected = Boolean(status.connected);
    rxBytes = Number(status.rxBytes) || rxBytes;
    txBytes = Number(status.txBytes) || txBytes;
    if (status.portPath) currentPort = status.portPath;
    if (status.options?.baudRate) baudRate = String(status.options.baudRate);
    if (status.options?.dataBits) dataBits = String(status.options.dataBits);
    if (status.options?.stopBits) stopBits = String(status.options.stopBits);
    if (status.options?.parity) parity = String(status.options.parity);
    if (status.options?.flowControl) flowControl = String(status.options.flowControl);
    if (status.signals) signals = { ...signals, ...status.signals };
  }

  function connectBackend() {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Backend reconnecting'));
    }
    pendingRequests.clear();

    if (backendWs) {
      backendWs.close();
      backendWs = null;
    }

    backendStatus = 'connecting';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    backendWs = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

    backendWs.addEventListener('open', async () => {
      try {
        const status = await request('status');
        backendStatus = 'ready';
        backendPid = Number(status.pid) || backendPid;
        applyStatus(status);
        notifyHostReady();
        await refreshPorts();
      } catch (error) {
        backendStatus = 'error';
        notifyHostError(error);
      }
    });

    backendWs.addEventListener('message', event => {
      try {
        handleBackendMessage(event.data);
      } catch (error) {
        notifyHostError(error);
        pushSystemRow('error', 'ERROR', error.message || String(error));
      }
    });

    backendWs.addEventListener('close', () => {
      if (backendStatus !== 'error') backendStatus = 'closed';
    });

    backendWs.addEventListener('error', () => {
      backendStatus = 'error';
      notifyHostError(new Error('Backend WebSocket connection failed'));
    });
  }

  async function refreshPorts() {
    try {
      const result = await request('serial.list');
      ports = Array.isArray(result.ports) ? result.ports : [];
      if (!currentPort && ports.length === 1) {
        currentPort = ports[0].path;
        saveSettings();
      }
    } catch (error) {
      pushSystemRow('error', 'PORTS_FAILED', error.message || String(error));
    }
  }

  function serialConnectOptions() {
    return {
      port: currentPort,
      baudRate: Number(baudRate),
      dataBits: Number(dataBits),
      stopBits: Number(stopBits),
      parity,
      flowControl
    };
  }

  async function toggleConnection() {
    if (connectLoading) return;
    connectLoading = true;

    try {
      if (connected) {
        await request('serial.disconnect');
        applyStatus({ connected: false });
      } else {
        if (!currentPort) throw new Error(t('SELECT_PORT_FIRST', 'Please select a serial port first'));
        const status = await request('serial.connect', serialConnectOptions(), 20000);
        applyStatus(status);
        saveSettings();
      }
    } catch (error) {
      pushSystemRow('error', 'ERROR', error.message || String(error));
      notifyHostError(error);
    } finally {
      connectLoading = false;
    }
  }

  async function sendData(payload = null, mode = null) {
    if (!connected || sendLoading) return;
    const data = payload === null ? inputValue : payload;
    if (!String(data || '').length) return;
    sendLoading = true;

    try {
      await request('serial.write', {
        mode: mode || (inputMode.hexMode ? 'hex' : 'text'),
        data,
        appendCr: !mode && inputMode.endR,
        appendLf: !mode && inputMode.endN
      });
      if (payload === null) inputValue = '';
    } catch (error) {
      pushSystemRow('error', 'SEND_FAILED', error.message || String(error));
      notifyHostError(error);
    } finally {
      sendLoading = false;
    }
  }

  async function sendSignal(signal) {
    if (!connected) return;
    try {
      const result = await request('serial.signal', {
        signal,
        state: !signals[signal]
      });
      if (result.signals) signals = { ...signals, ...result.signals };
    } catch (error) {
      pushSystemRow('error', 'SIGNAL_FAILED', error.message || String(error));
      notifyHostError(error);
    }
  }

  function signalSummary() {
    return `DTR=${signals.dtr ? '1' : '0'} RTS=${signals.rts ? '1' : '0'}`;
  }

  function clearLog() {
    rows = [];
    rxBytes = 0;
    txBytes = 0;
  }

  function exportLog() {
    const lines = rows.map(row => {
      const prefix = viewMode.showTimestamp ? `[${row.time}] ${row.dir}` : row.dir;
      return `${prefix} ${visibleText(row)}`;
    });
    const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `serial-debugger-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function handleQuickSend(item) {
    if (item.type === 'signal') {
      void sendSignal(item.signal);
    } else {
      void sendData(item.data, item.type);
    }
  }

  function toggleView(name) {
    viewMode = { ...viewMode, [name]: !viewMode[name] };
    saveSettings();
    void scrollToBottom();
  }

  function toggleInput(name) {
    inputMode = { ...inputMode, [name]: !inputMode[name] };
    saveSettings();
  }

  function saveScalarSettings() {
    saveSettings();
  }

  function handleInputKeydown(event) {
    if (inputMode.sendByEnter && event.key === 'Enter') {
      event.preventDefault();
      void sendData();
    } else if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      void sendData();
    }
  }

  onMount(() => {
    loadSettings();
    document.documentElement.lang = hostContext.lang;
    applyTheme(hostContext.theme);
    void loadI18n(hostContext.lang);
    connectHost();
    connectBackend();

    return () => {
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Serial debugger UI closed'));
      }
      pendingRequests.clear();
      if (backendWs) backendWs.close();
    };
  });
</script>

<div class="window-box">
  <div class="main-box">
    <section class="settings">
      <div class="line">
        <label class="item port-item">
          <span class="title">{t('PORT', 'Port')}</span>
          <span class="item-inner select-shell">
            <select bind:value={currentPort} disabled={connected || connectLoading} on:change={saveScalarSettings}>
              {#if !currentPort && ports.length}
                <option value="">{t('SELECT_PORT', 'Select port')}</option>
              {/if}
              {#if currentPort}
                <option value={currentPort}>{currentPort}</option>
              {/if}
              {#each ports as port}
                {#if port.path && port.path !== currentPort}
                  <option value={port.path}>{portLabel(port)}</option>
                {/if}
              {/each}
              {#if !ports.length && !currentPort}
                <option value="">{t('NO_PORTS', 'No serial ports')}</option>
              {/if}
            </select>
            <span class="value">{currentPort || (ports.length ? t('SELECT_PORT', 'Select port') : t('NO_PORTS', 'No serial ports'))}</span>
            <span class="arrow-box"></span>
          </span>
        </label>

        <label class="item">
          <span class="title">{t('BAUD_RATE', 'Baud Rate')}</span>
          <span class="item-inner select-shell">
            <select bind:value={baudRate} disabled={connected || connectLoading} on:change={saveScalarSettings}>
              {#each baudRates as item}
                <option value={item}>{item}</option>
              {/each}
            </select>
            <span class="value">{baudRate}</span>
            <span class="arrow-box">v</span>
          </span>
        </label>

        <button type="button" class="tb-btn" on:click={refreshPorts} title={t('REFRESH_PORTS', 'Refresh ports')}>
          <i class="fa-light fa-rotate-right"></i><span>{t('REFRESH', 'Refresh')}</span>
        </button>
        <button type="button" class:active={showAdvanced} class="tb-btn iconish" on:click={() => (showAdvanced = !showAdvanced)} title={t('MORE_SETTINGS', 'More Settings')}>
          <i class="fa-light fa-gear"></i>
        </button>
        <button type="button" class:on={connected} class="switch-control" on:click={toggleConnection} disabled={connectLoading} title={connected ? t('DISCONNECT', 'Disconnect') : t('CONNECT', 'Connect')}>
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </button>
        <span class:connected class:error={backendStatus === 'error'} class="status-pill">
          {connected ? t('CONNECTED', 'Connected') : t(backendStatus.toUpperCase(), backendStatus)}
        </span>
      </div>

      {#if showAdvanced}
        <div class="advanced">
          <label class="field compact">
            <span>{t('DATA_BITS', 'Data Bits')}</span>
            <select bind:value={dataBits} disabled={connected} on:change={saveScalarSettings}>
              {#each dataBitOptions as item}<option value={item}>{item}</option>{/each}
            </select>
          </label>
          <label class="field compact">
            <span>{t('STOP_BITS', 'Stop Bits')}</span>
            <select bind:value={stopBits} disabled={connected} on:change={saveScalarSettings}>
              {#each stopBitOptions as item}<option value={item}>{item}</option>{/each}
            </select>
          </label>
          <label class="field compact">
            <span>{t('PARITY', 'Parity')}</span>
            <select bind:value={parity} disabled={connected} on:change={saveScalarSettings}>
              {#each parityOptions as item}<option value={item}>{t(`PARITY_${item.toUpperCase()}`, item)}</option>{/each}
            </select>
          </label>
          <label class="field compact">
            <span>{t('FLOW_CONTROL', 'Flow Control')}</span>
            <select bind:value={flowControl} disabled={connected} on:change={saveScalarSettings}>
              {#each flowControlOptions as item}<option value={item}>{t(`FLOW_${item.toUpperCase()}`, item)}</option>{/each}
            </select>
          </label>
        </div>
      {/if}
    </section>

    <section class="monitor">
      <div class="r-box">
        <div class="data-list" id="data-list">
          {#if rows.length}
            {#each rows as row (row.id)}
              <div class:match={rowMatches(row)} class:no-time={!viewMode.showTimestamp} class:system={row.kind === 'system'} class={['data-row', row.dir.toLowerCase()].join(' ')}>
                {#if viewMode.showTimestamp}
                  <span class="time">{row.time}</span>
                {/if}
                <span class="dir">{row.dir}</span>
                <code class:nowrap={!viewMode.autoWrap}>{visibleText(row) || ' '}</code>
              </div>
            {/each}
          {:else}
            <div class="empty">
              <i class="fa-light fa-waveform-lines"></i>
              <p>{t('EMPTY_LOG', 'Serial traffic will appear here')}</p>
            </div>
          {/if}
        </div>

        <div class="monitor-toolbar">
          <button type="button" class:active={viewMode.showHex} class="tb-btn toggle" on:click={() => toggleView('showHex')}>{t('HEX_DISPLAY', 'Hex')}</button>
          <button type="button" class:active={viewMode.autoWrap} class="tb-btn toggle" on:click={() => toggleView('autoWrap')}>{t('AUTO_WRAP', 'Wrap')}</button>
          <button type="button" class:active={viewMode.autoScroll} class="tb-btn toggle" on:click={() => toggleView('autoScroll')}>{t('AUTO_SCROLL', 'Tail')}</button>
          <button type="button" class:active={viewMode.showTimestamp} class="tb-btn toggle" on:click={() => toggleView('showTimestamp')}>{t('TIMESTAMP', 'Time')}</button>
          <button type="button" class:active={viewMode.showCtrlChar} class="tb-btn toggle" on:click={() => toggleView('showCtrlChar')}>{t('SHOW_CTRL_CHAR', 'Ctrl')}</button>
          <label class="search-shell">
            <i class="fa-light fa-magnifying-glass"></i>
            <input type="search" bind:value={searchKeyword} placeholder={t('SEARCH', 'Search')}>
          </label>
          <span class="spacer"></span>
          <button type="button" class="tb-btn" on:click={exportLog}><i class="fa-light fa-download"></i><span>{t('EXPORT', 'Export')}</span></button>
          <button type="button" class="tb-btn" on:click={clearLog}><i class="fa-light fa-trash-can"></i><span>{t('CLEAR', 'Clear')}</span></button>
        </div>
      </div>
    </section>

    <section class="sender">
      <div class="quick-row">
        {#each quickSends as item}
          <button type="button" class:active={item.signal && signals[item.signal]} class="quick-btn" on:click={() => handleQuickSend(item)}>
            {t(item.label, item.label)}
          </button>
        {/each}
      </div>
      <div class="input-box">
        <textarea class="mono" bind:value={inputValue} on:keydown={handleInputKeydown} placeholder={t('INPUT_PLACEHOLDER', 'Enter data to send')}></textarea>
        <div class="sender-toolbar">
          <button type="button" class:active={inputMode.hexMode} class="tb-btn toggle" on:click={() => toggleInput('hexMode')}>{t('HEX_INPUT', 'Hex')}</button>
          <button type="button" class:active={inputMode.sendByEnter} class="tb-btn toggle" on:click={() => toggleInput('sendByEnter')}>{t('SEND_BY_ENTER', 'Enter')}</button>
          <button type="button" class:active={inputMode.endR} class="tb-btn toggle" on:click={() => toggleInput('endR')}>{t('END_R', '\\r')}</button>
          <button type="button" class:active={inputMode.endN} class="tb-btn toggle" on:click={() => toggleInput('endN')}>{t('END_N', '\\n')}</button>
          <span class="spacer"></span>
          <button type="button" class="tb-btn primary" on:click={() => sendData()} disabled={!connected || sendLoading}>
            <i class="fa-light fa-paper-plane"></i><span>{t('SEND', 'Send')}</span>
          </button>
        </div>
      </div>
    </section>

    <footer class="status-bar">
      <span>{t('PORT', 'Port')}: <strong>{connected ? currentPort : t('DISCONNECTED', 'Disconnected')}</strong></span>
      <span>{t('RX', 'RX')}: <strong>{formatBytes(rxBytes)}</strong></span>
      <span>{t('TX', 'TX')}: <strong>{formatBytes(txBytes)}</strong></span>
      <span>PID: <strong>{backendPid || '-'}</strong></span>
    </footer>
  </div>
</div>
