import { execFile } from 'node:child_process';

const MODEL_ROLES = ['default', 'advisor', 'slow'];
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const selector = value => typeof value === 'string' && /^[a-zA-Z0-9_.:/+@-]{1,240}$/.test(value);

// Only the named noncredential setting crosses this boundary. Never enumerate keys/tokens or invoke a test prompt.
const runModelCommand = (exe, args, cwd) => new Promise((resolve, reject) =>
  execFile(exe, args, { cwd, shell: false, windowsHide: true, timeout: 20000, maxBuffer: 2097152 },
    (error, stdout, stderr) => error || stderr.trim() ? reject(Error('OMP settings are unavailable')) : resolve(stdout)));

function rolesFrom(text) {
  const response = JSON.parse(text);
  if (response.key !== 'modelRoles' || !record(response.value) || Object.keys(response.value).length > 64 ||
      Object.entries(response.value).some(([key, value]) => !/^[a-zA-Z0-9_-]{1,64}$/.test(key) || (value !== '' && !selector(value)))) throw Error('OMP settings are unavailable');
  return response.value;
}

// Read-only: which of the roles OMP uses by default have no model chosen for this project. The choice itself is
// the user's (it depends on their providers), so this never writes and never starts a model call.
export async function modelRolesStatus(executable, cwd, run = runModelCommand) {
  try {
    const roles = rolesFrom(await run(executable, ['config', 'get', 'modelRoles', '--json'], cwd));
    const missing = MODEL_ROLES.filter(role => !roles[role]);
    return { status: missing.length ? 'missing' : 'ready', missing };
  } catch { return { status: 'unchecked', missing: [] }; }
}
