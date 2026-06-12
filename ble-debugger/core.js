'use strict';

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function loadNoble() {
  try {
    return require('@abandonware/noble');
  } catch (error) {
    throw new Error(`Failed to load @abandonware/noble: ${asError(error)}`);
  }
}

function normalizeUuid(uuid) {
  return String(uuid || '')
    .trim()
    .toLowerCase()
    .replace(/^0x/, '')
    .replace(/-/g, '');
}

function displayUuid(uuid) {
  const normalized = normalizeUuid(uuid);
  if (normalized.length === 4) return `0x${normalized.toUpperCase()}`;
  return normalized || '-';
}

function characteristicKey(deviceId, serviceUuid, characteristicUuid) {
  return `${String(deviceId || '')}:${normalizeUuid(serviceUuid)}:${normalizeUuid(characteristicUuid)}`;
}

function bufferToHex(buffer) {
  return Array.from(buffer || [])
    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

function bufferToAscii(buffer) {
  return Array.from(buffer || [])
    .map(byte => (byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'))
    .join('');
}

function parseHex(text) {
  const clean = String(text || '').replace(/0x/gi, '').replace(/[^a-fA-F0-9]/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error('Hex payload must contain an even number of digits');
  }
  const bytes = [];
  for (let index = 0; index < clean.length; index += 2) {
    bytes.push(parseInt(clean.slice(index, index + 2), 16));
  }
  return Buffer.from(bytes);
}

function payloadToBuffer(payload, mode = 'hex') {
  if (mode === 'ascii') {
    return Buffer.from(String(payload || ''), 'utf8');
  }
  return parseHex(payload);
}

function normalizeUuidList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeUuid).filter(Boolean);
}

function numberOption(value, defaultValue, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, parsed);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function callWithCallback(target, method, args = []) {
  return new Promise((resolve, reject) => {
    if (!target || typeof target[method] !== 'function') {
      reject(new Error(`${method} is not available`));
      return;
    }

    target[method](...args, (error, ...result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result.length <= 1 ? result[0] : result);
    });
  });
}

async function callAsync(target, asyncMethod, callbackMethod, args = []) {
  if (target && typeof target[asyncMethod] === 'function') {
    return await target[asyncMethod](...args);
  }
  return await callWithCallback(target, callbackMethod, args);
}

function createBleDebuggerCore(options = {}) {
  const noble = options.noble || loadNoble();
  const sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : null;
  const peripherals = new Map();
  const connections = new Map();
  const characteristicRefs = new Map();
  const notificationHandlers = new Map();

  let scanning = false;

  const emit = (event, data = {}) => {
    if (sendEvent) sendEvent(event, data);
  };

  function status() {
    return {
      state: noble.state || 'unknown',
      scanning,
      connected: connections.size > 0,
      connectedCount: connections.size,
      connectedDevices: Array.from(connections.values()).map(entry => ({
        device: entry.device,
        services: entry.services || []
      }))
    };
  }

  function peripheralId(peripheral) {
    return peripheral?.id || peripheral?.uuid || peripheral?.address || '';
  }

  function serializePeripheral(peripheral) {
    const advertisement = peripheral.advertisement || {};
    return {
      id: peripheral.id || peripheral.uuid || peripheral.address,
      uuid: peripheral.uuid || '',
      address: peripheral.address || '',
      addressType: peripheral.addressType || '',
      name: advertisement.localName || peripheral.name || peripheral.advertisement?.localName || 'Unknown device',
      localName: advertisement.localName || '',
      rssi: typeof peripheral.rssi === 'number' ? peripheral.rssi : null,
      connectable: peripheral.connectable !== false,
      serviceUuids: Array.isArray(advertisement.serviceUuids) ? advertisement.serviceUuids.map(displayUuid) : [],
      manufacturerData: advertisement.manufacturerData ? bufferToHex(advertisement.manufacturerData) : '',
      txPowerLevel: typeof advertisement.txPowerLevel === 'number' ? advertisement.txPowerLevel : null
    };
  }

  function serializeCharacteristic(deviceId, service, characteristic) {
    return {
      uuid: displayUuid(characteristic.uuid),
      rawUuid: normalizeUuid(characteristic.uuid),
      serviceUuid: displayUuid(service.uuid),
      rawServiceUuid: normalizeUuid(service.uuid),
      properties: characteristic.properties || [],
      lastValueHex: '',
      lastValueAscii: '',
      notifying: notificationHandlers.has(characteristicKey(deviceId, service.uuid, characteristic.uuid))
    };
  }

  function serializeService(deviceId, service, characteristics) {
    return {
      uuid: displayUuid(service.uuid),
      rawUuid: normalizeUuid(service.uuid),
      characteristics: characteristics.map(characteristic => serializeCharacteristic(deviceId, service, characteristic))
    };
  }

  async function waitForPoweredOn(timeoutMs = 10000) {
    if (noble.state === 'poweredOn') {
      return noble.state;
    }

    if (['unsupported', 'unauthorized', 'poweredOff'].includes(noble.state)) {
      throw new Error(`Bluetooth adapter is ${noble.state}`);
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        noble.removeListener('stateChange', onStateChange);
        reject(new Error(`Bluetooth adapter did not become poweredOn within ${timeoutMs} ms; current state is ${noble.state || 'unknown'}`));
      }, timeoutMs);

      const onStateChange = state => {
        if (state === 'poweredOn') {
          clearTimeout(timer);
          noble.removeListener('stateChange', onStateChange);
          resolve(state);
          return;
        }

        if (['unsupported', 'unauthorized', 'poweredOff'].includes(state)) {
          clearTimeout(timer);
          noble.removeListener('stateChange', onStateChange);
          reject(new Error(`Bluetooth adapter is ${state}`));
        }
      };

      noble.on('stateChange', onStateChange);
    });
  }

  async function startScan(options = {}) {
    const serviceUuids = normalizeUuidList(options.serviceUuids);
    const allowDuplicates = options.allowDuplicates !== false;
    const waitMs = numberOption(options.waitMs, 10000, 100);

    await waitForPoweredOn(waitMs);

    if (scanning) {
      await stopScan();
    }

    await callAsync(noble, 'startScanningAsync', 'startScanning', [serviceUuids, allowDuplicates]);
    scanning = true;
    return { scanning, serviceUuids, allowDuplicates };
  }

  async function stopScan() {
    if (!scanning) {
      return { scanning: false };
    }
    scanning = false;
    emit('scanStop', { scanning });
    await callAsync(noble, 'stopScanningAsync', 'stopScanning', []);
    scanning = false;
    return { scanning };
  }

  function clearGattCache(deviceId = '') {
    for (const [key, entry] of notificationHandlers.entries()) {
      if (deviceId && entry.deviceId !== deviceId) continue;
      entry.characteristic.removeListener('data', entry.handler);
      notificationHandlers.delete(key);
    }
    for (const [key, entry] of characteristicRefs.entries()) {
      if (deviceId && entry.deviceId !== deviceId) continue;
      characteristicRefs.delete(key);
    }
  }

  function resolveConnectedDeviceId(options = {}) {
    const requestedId = options.deviceId || options.connectedDeviceId;
    if (requestedId) {
      const id = String(requestedId);
      if (!connections.has(id)) {
        throw new Error('BLE device is not connected');
      }
      return id;
    }

    if (connections.size === 1) {
      return connections.keys().next().value;
    }

    if (!connections.size) {
      throw new Error('No connected BLE device');
    }

    throw new Error('Multiple BLE devices are connected; specify deviceId');
  }

  async function connectDevice(options = {}) {
    const id = options.id;
    const peripheral = peripherals.get(id);
    if (!peripheral) {
      throw new Error('Device is not in the scan cache');
    }

    if (scanning) {
      await stopScan();
    }

    if (peripheral.state !== 'connected') {
      await callAsync(peripheral, 'connectAsync', 'connect', []);
    }

    const deviceId = peripheralId(peripheral) || id;
    let connection = connections.get(deviceId);
    let createdConnection = false;
    if (!connection) {
      const onDisconnect = () => {
        clearGattCache(deviceId);
        connections.delete(deviceId);
        emit('disconnected', {
          id: deviceId,
          deviceId,
          device: connection?.device || serializePeripheral(peripheral)
        });
      };
      peripheral.once('disconnect', onDisconnect);
      connection = {
        peripheral,
        device: serializePeripheral(peripheral),
        services: [],
        disconnectHandler: onDisconnect
      };
      connections.set(deviceId, connection);
      createdConnection = true;
    } else {
      connection.peripheral = peripheral;
      connection.device = serializePeripheral(peripheral);
    }

    let gatt;
    try {
      gatt = await discoverGatt({ deviceId });
    } catch (error) {
      if (createdConnection) {
        await disconnectDevice({ deviceId }).catch(() => undefined);
      }
      throw error;
    }
    connection.services = gatt.services;
    connection.device = serializePeripheral(peripheral);
    emit('connected', { device: connection.device, deviceId, services: gatt.services });
    return { device: connection.device, deviceId, services: gatt.services };
  }

  async function disconnectDevice(options = {}) {
    const requestedId = options.deviceId || options.id;
    const deviceIds = requestedId ? [resolveConnectedDeviceId({ deviceId: requestedId })] : Array.from(connections.keys());

    if (!deviceIds.length) {
      clearGattCache();
      return { connected: false, disconnectedIds: [] };
    }

    const disconnectedIds = [];
    for (const deviceId of deviceIds) {
      const connection = connections.get(deviceId);
      if (!connection) continue;
      const { peripheral } = connection;

      clearGattCache(deviceId);
      connections.delete(deviceId);
      if (connection.disconnectHandler) {
        peripheral.removeListener('disconnect', connection.disconnectHandler);
      }

      if (peripheral.state === 'connected') {
        await callAsync(peripheral, 'disconnectAsync', 'disconnect', []);
      }

      disconnectedIds.push(deviceId);
      emit('disconnected', {
        id: deviceId,
        deviceId,
        device: connection.device || serializePeripheral(peripheral)
      });
    }

    return {
      connected: connections.size > 0,
      disconnectedIds,
      deviceId: disconnectedIds[0] || ''
    };
  }

  async function discoverGatt(options = {}) {
    const deviceId = resolveConnectedDeviceId(options);
    const connection = connections.get(deviceId);
    if (!connection || connection.peripheral.state !== 'connected') {
      throw new Error('No connected BLE device');
    }

    clearGattCache(deviceId);
    const serviceUuids = normalizeUuidList(options.serviceUuids);
    const services = await callAsync(connection.peripheral, 'discoverServicesAsync', 'discoverServices', [serviceUuids]);
    const result = [];

    for (const service of services || []) {
      const characteristics = await callAsync(service, 'discoverCharacteristicsAsync', 'discoverCharacteristics', [[]]);
      for (const characteristic of characteristics || []) {
        characteristicRefs.set(characteristicKey(deviceId, service.uuid, characteristic.uuid), { deviceId, service, characteristic });
      }
      result.push(serializeService(deviceId, service, characteristics || []));
    }

    connection.services = result;
    return { deviceId, services: result };
  }

  function getCharacteristic(options = {}) {
    const deviceId = resolveConnectedDeviceId(options);
    const key = characteristicKey(deviceId, options.serviceUuid, options.characteristicUuid);
    const entry = characteristicRefs.get(key);
    if (!entry) {
      throw new Error('Characteristic is not in the discovered GATT cache');
    }
    return { key, ...entry };
  }

  async function readCharacteristic(options = {}) {
    const { deviceId, service, characteristic } = getCharacteristic(options);
    const value = await callAsync(characteristic, 'readAsync', 'read', []);
    const data = Buffer.from(value || []);
    return {
      deviceId,
      serviceUuid: displayUuid(service.uuid),
      characteristicUuid: displayUuid(characteristic.uuid),
      valueHex: bufferToHex(data),
      valueAscii: bufferToAscii(data),
      byteLength: data.length
    };
  }

  async function writeCharacteristic(options = {}) {
    const { deviceId, service, characteristic } = getCharacteristic(options);
    const value = payloadToBuffer(options.payload, options.mode);
    const withoutResponse = options.withoutResponse === true;
    await callAsync(characteristic, 'writeAsync', 'write', [value, withoutResponse]);
    return {
      deviceId,
      serviceUuid: displayUuid(service.uuid),
      characteristicUuid: displayUuid(characteristic.uuid),
      valueHex: bufferToHex(value),
      valueAscii: bufferToAscii(value),
      byteLength: value.length,
      withoutResponse
    };
  }

  async function subscribeCharacteristic(options = {}) {
    const { key, deviceId, service, characteristic } = getCharacteristic(options);
    if (!notificationHandlers.has(key)) {
      const handler = (data, isNotification) => {
        const value = Buffer.from(data || []);
        emit('notification', {
          deviceId,
          serviceUuid: displayUuid(service.uuid),
          characteristicUuid: displayUuid(characteristic.uuid),
          valueHex: bufferToHex(value),
          valueAscii: bufferToAscii(value),
          byteLength: value.length,
          isNotification: isNotification !== false
        });
      };
      characteristic.on('data', handler);
      notificationHandlers.set(key, { deviceId, characteristic, handler });
    }

    await callAsync(characteristic, 'subscribeAsync', 'subscribe', []);
    return {
      deviceId,
      serviceUuid: displayUuid(service.uuid),
      characteristicUuid: displayUuid(characteristic.uuid),
      notifying: true
    };
  }

  async function unsubscribeCharacteristic(options = {}) {
    const { key, deviceId, service, characteristic } = getCharacteristic(options);
    const entry = notificationHandlers.get(key);
    if (entry) {
      characteristic.removeListener('data', entry.handler);
      notificationHandlers.delete(key);
    }

    await callAsync(characteristic, 'unsubscribeAsync', 'unsubscribe', []);
    return {
      deviceId,
      serviceUuid: displayUuid(service.uuid),
      characteristicUuid: displayUuid(characteristic.uuid),
      notifying: false
    };
  }

  async function shutdown() {
    try {
      await stopScan();
    } catch (error) {
      emit('log', { level: 'warn', message: asError(error) });
    }
    try {
      await disconnectDevice();
    } catch (error) {
      emit('log', { level: 'warn', message: asError(error) });
    }
    return { closing: true };
  }

  async function cleanup() {
    try {
      if (scanning) await stopScan();
    } catch {}
    try {
      if (connections.size) await disconnectDevice();
    } catch {}
  }

  function matchesDevice(device, selector) {
    const id = String(selector.id || selector.device || '').toLowerCase();
    const address = String(selector.address || '').toLowerCase();
    const name = String(selector.name || '').toLowerCase();
    const contains = String(selector.nameContains || selector.contains || '').toLowerCase();
    const deviceId = String(device.id || '').toLowerCase();
    const uuid = String(device.uuid || '').toLowerCase();
    const deviceAddress = String(device.address || '').toLowerCase();
    const deviceName = String(device.name || device.localName || '').toLowerCase();

    if (id && ![deviceId, uuid, deviceAddress].includes(id)) return false;
    if (address && deviceAddress !== address) return false;
    if (name && deviceName !== name) return false;
    if (contains && !deviceName.includes(contains)) return false;
    return !!(id || address || name || contains);
  }

  async function scanDevices(options = {}) {
    const durationMs = numberOption(options.durationMs, 5000, 250);
    const waitMs = numberOption(options.waitMs, 10000, 100);
    const serviceUuids = normalizeUuidList(options.serviceUuids);
    const allowDuplicates = options.allowDuplicates === true;
    const devices = new Map();

    await waitForPoweredOn(waitMs);

    const onDiscover = peripheral => {
      const id = peripheral.id || peripheral.uuid || peripheral.address;
      if (!id) return;
      peripherals.set(id, peripheral);
      devices.set(id, serializePeripheral(peripheral));
    };

    noble.on('discover', onDiscover);
    try {
      await startScan({ serviceUuids, allowDuplicates });
      await sleep(durationMs);
      await stopScan();
    } finally {
      noble.removeListener('discover', onDiscover);
      if (scanning) {
        await stopScan().catch(() => undefined);
      }
    }

    return {
      state: noble.state || 'unknown',
      durationMs,
      serviceUuids,
      devices: Array.from(devices.values()).sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
    };
  }

  async function findPeripheral(selector = {}) {
    const waitMs = numberOption(selector.waitMs, 10000, 100);
    const scanMs = numberOption(selector.scanMs || selector.durationMs, 10000, 250);
    const serviceUuids = normalizeUuidList(selector.scanServiceUuids);
    const allowDuplicates = selector.allowDuplicates !== false;
    const startedAt = Date.now();

    await waitForPoweredOn(waitMs);

    for (const peripheral of peripherals.values()) {
      const device = serializePeripheral(peripheral);
      if (matchesDevice(device, selector)) {
        return peripheral;
      }
    }

    return await new Promise((resolve, reject) => {
      let settled = false;

      const finish = (error, peripheral = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        noble.removeListener('discover', onDiscover);

        const stop = scanning ? stopScan().catch(() => undefined) : Promise.resolve();
        stop.finally(() => {
          if (error) reject(error);
          else resolve(peripheral);
        });
      };

      const timer = setTimeout(() => {
        finish(new Error(`BLE device was not found within ${scanMs} ms`));
      }, scanMs);

      const onDiscover = peripheral => {
        const id = peripheral.id || peripheral.uuid || peripheral.address;
        if (!id) return;
        peripherals.set(id, peripheral);
        const device = serializePeripheral(peripheral);
        if (matchesDevice(device, selector)) {
          finish(null, peripheral);
        }
      };

      noble.on('discover', onDiscover);
      startScan({ serviceUuids, allowDuplicates }).catch(error => finish(error));
    }).then(peripheral => {
      peripheral.__ailyScanElapsedMs = Date.now() - startedAt;
      return peripheral;
    });
  }

  async function connectBySelector(selector = {}) {
    const peripheral = await findPeripheral(selector);
    const id = peripheral.id || peripheral.uuid || peripheral.address;
    const result = await connectDevice({ id });
    return {
      ...result,
      scanElapsedMs: peripheral.__ailyScanElapsedMs || 0
    };
  }

  async function withConnectedDevice(selector, task) {
    let connection = null;
    try {
      connection = await connectBySelector(selector);
      const result = await task(connection);
      return {
        device: connection.device,
        ...result
      };
    } finally {
      if (connection?.device?.id) {
        await disconnectDevice({ deviceId: connection.device.id }).catch(() => undefined);
      }
    }
  }

  async function readBySelector(options = {}) {
    return await withConnectedDevice(options, async connection => ({
      value: await readCharacteristic({ ...options, deviceId: connection.device.id })
    }));
  }

  async function writeBySelector(options = {}) {
    return await withConnectedDevice(options, async connection => ({
      value: await writeCharacteristic({ ...options, deviceId: connection.device.id })
    }));
  }

  async function notifyBySelector(options = {}) {
    const durationMs = numberOption(options.durationMs, 10000, 250);
    return await withConnectedDevice(options, async connection => {
      const notifications = [];
      const deviceId = connection.device.id;
      const { service, characteristic } = getCharacteristic({ ...options, deviceId });
      const handler = (data, isNotification) => {
        const value = Buffer.from(data || []);
        notifications.push({
          time: new Date().toISOString(),
          deviceId,
          serviceUuid: displayUuid(service.uuid),
          characteristicUuid: displayUuid(characteristic.uuid),
          valueHex: bufferToHex(value),
          valueAscii: bufferToAscii(value),
          byteLength: value.length,
          isNotification: isNotification !== false
        });
      };

      const key = characteristicKey(deviceId, service.uuid, characteristic.uuid);
      characteristic.on('data', handler);
      notificationHandlers.set(key, { deviceId, characteristic, handler });

      try {
        await callAsync(characteristic, 'subscribeAsync', 'subscribe', []);
        await sleep(durationMs);
        await callAsync(characteristic, 'unsubscribeAsync', 'unsubscribe', []);
      } finally {
        characteristic.removeListener('data', handler);
        notificationHandlers.delete(key);
      }

      return {
        subscription: {
          serviceUuid: displayUuid(service.uuid),
          characteristicUuid: displayUuid(characteristic.uuid),
          durationMs
        },
        notifications
      };
    });
  }

  async function executeAction(message = {}) {
    switch (message.action) {
      case 'status':
        return status();
      case 'startScan':
        return await startScan(message);
      case 'stopScan':
        return await stopScan();
      case 'connect':
        return await connectDevice(message);
      case 'disconnect':
        return await disconnectDevice(message);
      case 'discoverGatt':
        return await discoverGatt(message);
      case 'read':
        return await readCharacteristic(message);
      case 'write':
        return await writeCharacteristic(message);
      case 'subscribe':
        return await subscribeCharacteristic(message);
      case 'unsubscribe':
        return await unsubscribeCharacteristic(message);
      case 'shutdown':
        return await shutdown();
      default:
        throw new Error(`Unknown action: ${message.action}`);
    }
  }

  noble.on('stateChange', state => {
    emit('state', { state, scanning });
    if (state !== 'poweredOn' && scanning) {
      noble.stopScanning();
      scanning = false;
      emit('scanStop', { scanning });
    }
  });

  noble.on('scanStart', () => {
    scanning = true;
    emit('scanStart', { scanning });
  });

  noble.on('scanStop', () => {
    scanning = false;
    emit('scanStop', { scanning });
  });

  noble.on('discover', peripheral => {
    const id = peripheral.id || peripheral.uuid || peripheral.address;
    if (!id) return;
    peripherals.set(id, peripheral);
    emit('device', serializePeripheral(peripheral));
  });

  return {
    noble,
    status,
    startScan,
    stopScan,
    connectDevice,
    disconnectDevice,
    discoverGatt,
    readCharacteristic,
    writeCharacteristic,
    subscribeCharacteristic,
    unsubscribeCharacteristic,
    shutdown,
    cleanup,
    waitForPoweredOn,
    scanDevices,
    findPeripheral,
    connectBySelector,
    withConnectedDevice,
    readBySelector,
    writeBySelector,
    notifyBySelector,
    executeAction
  };
}

module.exports = {
  asError,
  createBleDebuggerCore,
  normalizeUuid,
  displayUuid,
  bufferToHex,
  bufferToAscii
};
