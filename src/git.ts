// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

/** An error the user can act on; printed without a stack trace. */
export class Failure extends Error {}

export const MIN_GIT: [number, number] = [2, 38]; // git merge-tree --write-tree

interface GitOptions {
  check?: boolean;
  env?: Record<string, string>;
  input?: string;
}

function spawn(args: string[], opts: GitOptions = {}) {
  const proc = spawnSync("git", args, {
    env: { ...process.env, ...opts.env },
    input: opts.input,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (proc.error) throw new Failure(`git ${args[0]}: ${proc.error.message}`);
  return { status: proc.status ?? -1, stdout: proc.stdout, stderr: proc.stderr.toString("utf8").trim() };
}

export function git(args: string[], opts: GitOptions = {}): string {
  const proc = spawn(args, opts);
  if ((opts.check ?? true) && proc.status !== 0) {
    throw new Failure(`git ${args.join(" ")} failed:\n${proc.stderr || proc.stdout.toString("utf8").trim()}`);
  }
  return proc.stdout.toString("utf8").trim();
}

export function gitOk(args: string[]): boolean {
  return spawn(args).status === 0;
}

function splitNul(buf: Buffer): string[] {
  return buf
    .toString("utf8")
    .split("\0")
    .filter((p) => p !== "");
}

/** Run a git subcommand with -z (inserted right after the subcommand) and return the paths it prints. */
export function gitPaths(args: string[]): string[] {
  const [sub, ...rest] = args;
  const proc = spawn([sub as string, "-z", ...rest]);
  if (proc.status !== 0) throw new Failure(`git ${args.join(" ")} failed:\n${proc.stderr}`);
  return splitNul(proc.stdout);
}

export function gitVersion(): [number, number] {
  const m = /(\d+)\.(\d+)/.exec(git(["--version"]));
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}

export function revList(...args: string[]): string[] {
  const out = git(["rev-list", ...args]);
  return out ? out.split(/\s+/) : [];
}

export function parentsOf(sha: string): string[] {
  return git(["rev-list", "--parents", "-n1", sha]).split(/\s+/).slice(1);
}

export function trailerValue(sha: string, key: string): string | null {
  const lines = git(["log", "-1", "--format=%B", sha]).split("\n").reverse();
  for (const line of lines) {
    if (line.startsWith(`${key}:`)) return line.slice(key.length + 1).trim();
  }
  return null;
}

/** Merge in memory. Returns the tree when clean, or the conflicting paths. */
export function mergeTree(ours: string, theirs: string): { tree: string | null; conflicts: string[] } {
  const proc = spawn(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs]);
  if (proc.status !== 0 && proc.status !== 1) {
    if (proc.stderr.includes("unrelated histories")) {
      throw new Failure(
        "upstream and the fork share no history. Merge upstream once by hand " +
          "(git merge --allow-unrelated-histories) and push that to the fork branch.",
      );
    }
    throw new Failure(`git merge-tree failed: ${proc.stderr}`);
  }
  const fields = splitNul(proc.stdout);
  return proc.status === 0 ? { tree: fields[0] ?? null, conflicts: [] } : { tree: null, conflicts: fields.slice(1) };
}
