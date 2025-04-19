import * as core from "@actions/core";
import { getExecOutput } from "@actions/exec";

/**
 * Represents the result of executing a Git command.
 */
export interface GitResult {
  /** The standard output stream content as a string. */
  stdout: string;

  /** The standard error stream content as a string. */
  stderr: string;

  /** The exit code returned by the Git process. */
  exitCode: number;
}

// Exec Git Helper
export async function execute_git(command: string, args: string[], options: { ignoreReturnCode?: boolean, silent?: boolean, cwd?: string } = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  core.debug(`Executing: git ${command} ${args.join(" ")} ${options.cwd ? `(in ${options.cwd})` : ''}`);
  try {
    const result = await getExecOutput("git", [command, ...args], {
      ignoreReturnCode: options.ignoreReturnCode ?? false,
      silent: options.silent ?? false,
      cwd: options.cwd // Pass current working directory if specified
    });

    // Only fail if ignoreReturnCode is false AND exit code is non-zero
    if (!options.ignoreReturnCode && result.exitCode !== 0) {
      core.error(`Git command failed: git ${command} ${args.join(" ")} - Exit Code: ${result.exitCode}`);
      core.error(`stderr: ${result.stderr}`);
      throw new Error(`Git command failed with exit code ${result.exitCode}. Stderr: ${result.stderr}`);
    }

    // Log output even on non-zero exit code if not silent, as it might be informative
    core.debug(`Git command finished: git ${command} - Exit Code: ${result.exitCode}`);
    if (result.stdout) {
      core.debug(`stdout: ${result.stdout}`);
    }
    // Log stderr only if it's not silent OR if it's an actual error (non-zero exit)
    if (result.stderr && (!options.silent || result.exitCode !== 0)) {
      core.debug(`stderr: ${result.stderr}`);
    }

    return result;
  } catch (error: any) {
    // Catch errors thrown by getExecOutput itself (e.g., command not found)
    // or the re-thrown error from above
    core.error(`Error executing git command: git ${command} ${args.join(" ")}: ${error.message}`);
    // Attempt to log stderr/stdout if they exist on the error object
    if (error.stderr) core.error(`stderr: ${error.stderr}`);
    if (error.stdout) core.debug(`stdout (on error): ${error.stdout}`);
    throw error; // Re-throw the original error
  }
}
