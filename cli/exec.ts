import { spawn } from "node:child_process"

/* Every subprocess the setup command starts goes through here: argv arrays only, never a shell,
   so no input can be read as shell syntax. A secret is passed on stdin (`input`), never as an
   argument, and stdout/stderr are returned to the caller, never echoed. */

export type RunResult = { code: number; stdout: string; stderr: string }
export type RunOptions = { cwd?: string; input?: string; env?: Record<string, string | undefined>; timeoutMs?: number }
export type Run = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>

export const run: Run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs ?? 120_000)
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: 127, stdout, stderr: stderr + String(err) })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()
  })

/** Throws with the command name and exit code only: output can hold secrets, so it never goes into the message. */
export async function mustRun(r: Run, cmd: string, args: string[], opts?: RunOptions): Promise<string> {
  const res = await r(cmd, args, opts)
  if (res.code !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed (exit ${res.code})`)
  return res.stdout
}
