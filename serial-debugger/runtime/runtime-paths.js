'use strict';

const os = require('os');
const path = require('path');

function resolveRuntimeRoot(explicitRoot = '') {
  if (explicitRoot) return path.resolve(String(explicitRoot));
  if (process.env.AILY_SERIAL_RUNTIME_DIR) {
    return path.resolve(process.env.AILY_SERIAL_RUNTIME_DIR);
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'aily-project', 'serial-debugger', 'runtime');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'aily-project', 'serial-debugger', 'runtime');
  }

  const stateRoot = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(stateRoot, 'aily-project', 'serial-debugger', 'runtime');
}

module.exports = {
  resolveRuntimeRoot
};
