// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const ROOT = join(import.meta.dir, "..");

export const ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export function run(cwd: string, cmd: string[], opts: { check?: boolean; env?: Record<string, string> } = {}) {
  const [bin, ...args] = cmd;
  const p = spawnSync(bin as string, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...ENV, FORK_KIT_GIT_NAME: "", FORK_KIT_GIT_EMAIL: "", ...opts.env },
  });
  if ((opts.check ?? true) && p.status !== 0) throw new Error(`${cmd.join(" ")} failed:\n${p.stdout}\n${p.stderr}`);
  return p;
}

export function git(cwd: string, args: string[], opts: { check?: boolean; env?: Record<string, string> } = {}) {
  return run(cwd, ["git", ...args], opts).stdout.trim();
}

export function commit(repo: string, path: string, content: string, msg: string): string {
  const p = join(repo, path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  git(repo, ["add", path]);
  git(repo, ["commit", "-q", "-m", msg]);
  return git(repo, ["rev-parse", "HEAD"]);
}

const MANIFEST = (url: string, track: string, forkExtra: string) => `
[upstream]
url = "${url}"
track = "${track}"

[fork]
branch = "patched"
${forkExtra}

[ledger]
ignore = [".github/workflows/fork-kit.yml"]

[[patch]]
id = "greeting"
summary = "Greet in German"
paths = ["src/hello.txt"]
tests = ["test_greeting"]

[[patch]]
id = "extra"
summary = "An extra feature"
paths = ["src/extra/**"]
`;

export interface FakePr {
  number: number;
  url: string;
  labels: string[];
  automerge: boolean;
  comments: string[];
  state: string;
  body: string;
}

export interface FakeState {
  prs: FakePr[];
  calls: unknown[];
  releases?: Record<string, string>;
  checks?: Record<string, string>;
}

/** upstream (a working repo used as the upstream url), origin (bare fork), work (clone of origin). */
export class Repos {
  readonly tmp = mkdtempSync(join(tmpdir(), "fork-kit-test-"));
  readonly upstream = join(this.tmp, "upstream");
  readonly origin = join(this.tmp, "origin.git");
  readonly work = join(this.tmp, "work");
  readonly forge = join(this.tmp, "forge.json");

  constructor(track = "branch:main", forkExtra = "") {
    git(this.tmp, ["init", "-q", "-b", "main", this.upstream]);
    commit(this.upstream, "src/hello.txt", "hello\nworld\n", "upstream: init");
    commit(this.upstream, "README", "upstream\n", "upstream: readme");
    git(this.tmp, ["init", "-q", "--bare", "-b", "patched", this.origin]);
    git(this.tmp, ["clone", "-q", this.upstream, this.work]);
    git(this.work, ["remote", "rename", "origin", "upstream"]);
    git(this.work, ["remote", "add", "origin", this.origin]);
    git(this.work, ["checkout", "-q", "-b", "patched"]);
    commit(this.work, "src/hello.txt", "hallo\nworld\n", "fork: greet in German");
    commit(this.work, "src/extra/feature.txt", "feature\n", "fork: extra");
    writeFileSync(join(this.work, ".fork-kit.toml"), MANIFEST(this.upstream, track, forkExtra));
    git(this.work, ["add", ".fork-kit.toml"]);
    git(this.work, ["commit", "-q", "-m", "fork: manifest"]);
    git(this.work, ["push", "-q", "origin", "patched"]);
    writeFileSync(this.forge, JSON.stringify({ prs: [], calls: [] }));
  }

  // biome-ignore lint/suspicious/noExplicitAny: test results are free-form JSON
  cli(args: string[], opts: { env?: Record<string, string>; runtime?: string[] } = {}): [any, ReturnType<typeof run>] {
    const runtime = opts.runtime ?? ["bun", join(ROOT, "src/bin.ts")];
    const p = run(this.work, [...runtime, "--json", ...args], {
      check: false,
      env: { FORK_KIT_FORGE: `fake:${this.forge}`, GITHUB_STEP_SUMMARY: "", GITHUB_OUTPUT: "", ...opts.env },
    });
    const start = p.stdout.indexOf("{\n");
    return [start >= 0 ? JSON.parse(p.stdout.slice(start)) : null, p];
  }

  state(): FakeState {
    return JSON.parse(readFileSync(this.forge, "utf8"));
  }

  editState(fn: (s: FakeState) => void) {
    const s = this.state();
    fn(s);
    writeFileSync(this.forge, JSON.stringify(s));
  }

  sha(ref: string): string {
    return git(this.origin, ["rev-parse", "--verify", "-q", ref], { check: false });
  }

  syncSha(): string {
    return this.sha("refs/heads/fork-kit/sync");
  }

  parents(sha: string): string[] {
    return git(this.origin, ["rev-list", "--parents", "-n1", sha]).split(/\s+/).slice(1);
  }

  pushFork(path: string, content: string, msg: string): string {
    git(this.work, ["checkout", "-q", "patched"]);
    git(this.work, ["pull", "-q", "--ff-only", "origin", "patched"]);
    const sha = commit(this.work, path, content, msg);
    git(this.work, ["push", "-q", "origin", "patched"]);
    return sha;
  }

  cleanup() {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}
