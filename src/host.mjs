import { execFile } from 'node:child_process';

// POTS has no list of supported OMP versions. Every OMP version, old and new, is treated the same way.
// An OMP executable is recognized only by a line of its `--version` answer that is exactly `omp/<major>.<minor>.<patch>`.
// Other lines (a banner, a notice) are ignored; no such line, or two different ones, means not recognized.
// Safety never comes from the version: it comes from the transcript proof that the exact submitted message
// ran, plus the runtime capability checks in the extension.
export const isOmpVersion = host => typeof host === 'string' && /^omp\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(host);
export const ompVersionLine = stdout => {
  const found = new Set(String(stdout).split(/\r?\n/).map(line => line.trim()).filter(isOmpVersion));
  return found.size === 1 ? [...found][0] : null;
};

// Bounded, read-only probe of the running executable's `--version`. Any
// failure, timeout or unexpected output yields null (not recognized as OMP). No
// environment self-attestation or ctx field is trusted.
export function detectHost(executable = process.execPath, timeout = 2000) {
  return new Promise(resolve => {
    try {
      const env = { ...process.env }; delete env.OMP_BRIDGE_CONFIG;
      const child = execFile(executable, ['--version'], { timeout, maxBuffer: 65536, windowsHide: true, shell: false, env },
        (error, stdout) => resolve(error ? null : ompVersionLine(stdout)));
      child.stdin?.end();
    } catch { resolve(null); }
  });
}

// Maps an agent_end payload to Supervisor.ended's willContinue argument. One rule for every OMP version:
// an omitted field means the run finished (false), an explicit true means OMP continues, an explicit false
// means finished, and any other value is malformed (undefined; the plan then ends `malformed`).
// OMP reports a settled run by leaving the field out and a scheduled continuation as true.
export function terminalSignal(event) {
  const value = event?.willContinue;
  if (typeof value === 'boolean') return value;
  return value === undefined ? false : undefined;
}
