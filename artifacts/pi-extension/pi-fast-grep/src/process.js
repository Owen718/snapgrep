import { spawn } from "node:child_process";
export class CommandError extends Error {
    command;
    args;
    code;
    stdout;
    stderr;
    constructor(command, args, result) {
        const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
        super(`${command} failed: ${detail}`);
        this.name = "CommandError";
        this.command = command;
        this.args = args;
        this.code = result.code;
        this.stdout = result.stdout;
        this.stderr = result.stderr;
    }
}
export async function runCommand(command, args, options = {}) {
    const started = performance.now();
    const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });
    let killTimer;
    const abort = () => {
        if (child.exitCode !== null)
            return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
            if (child.exitCode === null)
                child.kill("SIGKILL");
        }, 2_000);
        killTimer.unref();
    };
    if (options.signal?.aborted)
        abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, closeSignal) => {
            if (options.signal?.aborted) {
                reject(options.signal.reason ?? new Error("Operation aborted"));
                return;
            }
            if (closeSignal && exitCode === null) {
                reject(new Error(`${command} terminated by ${closeSignal}`));
                return;
            }
            resolve(exitCode ?? 1);
        });
    }).finally(() => {
        if (killTimer !== undefined)
            clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
    });
    const result = {
        code,
        stdout,
        stderr,
        durationMs: performance.now() - started,
    };
    const allowed = options.allowExitCodes ?? [0];
    if (!allowed.includes(code))
        throw new CommandError(command, args, result);
    return result;
}
