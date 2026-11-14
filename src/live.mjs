import { runPowerShell, HelperFailure } from './uninstall.mjs';

// The OMP programs running right now: Setup only counts them to say whether a session is open. The command lines
// stay local and are never returned to assistants or printed.
export async function windowsProcesses(env = process.env, { exec } = {}) {
  const step = 'list the running OMP programs';
  const script = "$ErrorActionPreference='Stop';@{processes=@(Get-CimInstance Win32_Process -Filter \"Name='omp.exe'\" | ForEach-Object{@{pid=[int]$_.ProcessId;executable=$_.ExecutablePath;commandLine=$_.CommandLine;createdAt=if($_.CreationDate){([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}else{0}}})}|ConvertTo-Json -Depth 4 -Compress";
  const out = await runPowerShell(step, script, { system: env.SystemRoot || env.SYSTEMROOT, timeout: 30000, maxBuffer: 4194304, exec });
  let rows;
  try { rows = JSON.parse(out).processes; } catch { rows = null; }
  if (!Array.isArray(rows)) throw new HelperFailure(`Windows gave an answer Setup could not read when it tried to ${step}.`, `${step}: not a process list`, 'script');
  if (rows.length > 64) throw new HelperFailure(`Windows reports ${rows.length} running OMP programs, more than the 64 Setup can check safely, so Setup will not guess which belongs to which project.`, `${step}: ${rows.length} omp.exe processes`, 'output');
  return rows;
}
