import { spawnSync } from 'node:child_process';

/** Interpreter for inline Python in tests: env PYTHON, else first of python3/python that runs. */
export function pythonExecutable() {
  const fromEnv = typeof process.env.PYTHON === 'string' ? process.env.PYTHON.trim() : '';
  if (fromEnv) {
    const envProbe = spawnSync(fromEnv, ['-c', 'pass'], { encoding: 'utf8' });
    if (envProbe.status === 0) return fromEnv;
  }
  for (const exe of ['python3', 'python']) {
    const probe = spawnSync(exe, ['-c', 'pass'], { encoding: 'utf8' });
    if (probe.status === 0) return exe;
  }
  return 'python3';
}
