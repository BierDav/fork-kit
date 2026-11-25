// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import type { Forge } from "./forge.ts";
import {
  Failure,
  git,
  gitOk,
  gitPaths,
  gitVersion,
  MIN_GIT,
  mergeTree,
  parentsOf,
  revList,
  trailerValue,
} from "./git.ts";
import type { Manifest } from "./manifest.ts";
import { naturalCompare, patchesFor, SAFE_REF } from "./text.ts";

export const TRAILER = "Fork-Kit-Upstream";
const UPSTREAM_REF = "refs/fork-kit-state/upstream";

export type Outcome =
  | "up-to-date"
  | "clean"
  | "conflict"
  | "hands-off"
  | "workflow-review"
  | "diverged"
  | "not-sync-pr";
export type SyncState = "none" | "pure" | "stale" | "foreign";

export interface Conflict {
  path: string;
  patches: string[];
}

export interface Plan {
  outcome: Outcome;
  upstreamRef: string;
  upstreamSha: string;
  forkSha: string;
  base: string;
  behind: number;
  conflicts: Conflict[];
  workflowChanges: string[];
  syncSha: string | null;
  syncState: SyncState;
  notes: string[];
}

export function identity(): Record<string, string> {
  const name = process.env.FORK_KIT_GIT_NAME || "fork-kit[bot]";
  const email = process.env.FORK_KIT_GIT_EMAIL || "fork-kit[bot]@users.noreply.github.com";
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

/** Return the upstream ref name and commit to track, fetched into UPSTREAM_REF. */
async function resolveUpstream(m: Manifest, forge: Forge): Promise<[string, string]> {
  let ref: string;
  let src: string;
  if (m.trackKind === "branch") {
    ref = m.trackArg;
    src = `refs/heads/${ref}`;
  } else {
    if (m.trackKind === "release") {
      ref = await forge.latestRelease(m.upstreamUrl);
    } else {
      const pattern = new RegExp(`^(?:${m.trackArg})$`);
      const tags = git(["ls-remote", "--tags", "--refs", m.upstreamUrl])
        .split("\n")
        .map((line) => line.split("refs/tags/")[1])
        .filter((t): t is string => t !== undefined && pattern.test(t));
      if (tags.length === 0) throw new Failure(`no upstream tag matches ${JSON.stringify(m.trackArg)}`);
      ref = tags.sort(naturalCompare).at(-1) as string;
    }
    src = `refs/tags/${ref}`;
  }
  if (!SAFE_REF.test(ref))
    throw new Failure(`upstream ref ${JSON.stringify(ref)} has characters fork-kit does not accept`);
  git(["fetch", "--quiet", "--no-tags", m.upstreamUrl, `+${src}:${UPSTREAM_REF}`]);
  return [ref, git(["rev-parse", `${UPSTREAM_REF}^{commit}`])];
}

/** Fetch the fork branch and the sync branch from origin. */
function fetchFork(m: Manifest): [string, string | null] {
  git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${m.branch}:refs/fork-kit-state/fork`]);
  const fork = git(["rev-parse", "refs/fork-kit-state/fork"]);
  if (!git(["ls-remote", "origin", `refs/heads/${m.syncBranch}`])) return [fork, null];
  git(["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${m.syncBranch}:refs/fork-kit-state/sync`]);
  return [fork, git(["rev-parse", "refs/fork-kit-state/sync"])];
}

/**
 * What the sync branch head is. "pure": exactly the commit fork-kit would build (its trailer, its committer,
 * upstream plus a commit already on the fork branch as parents, and the tree fork-kit computes for them).
 * "stale": the same, but its fork parent is no longer on the fork branch (force-moved). "foreign": anything
 * else, i.e. someone else's work. The trailer, committer and parents can be forged by anyone who can push,
 * so the recorded upstream must also be upstream's commit (or an older one of upstream's): then the whole
 * commit follows from trusted inputs.
 */
export function classifySync(sync: string, fork: string, upstream: string): SyncState {
  const recorded = trailerValue(sync, TRAILER);
  if (!recorded || !gitOk(["cat-file", "-e", `${recorded}^{commit}`])) return "foreign";
  if (!gitOk(["merge-base", "--is-ancestor", recorded, upstream])) return "foreign";
  if (git(["log", "-1", "--format=%ce", sync]) !== identity().GIT_COMMITTER_EMAIL) return "foreign";
  const parents = parentsOf(sync);
  const tree = git(["rev-parse", `${sync}^{tree}`]);
  if (parents.length === 1 && parents[0] === recorded) {
    return tree === git(["rev-parse", `${recorded}^{tree}`]) ? "pure" : "foreign";
  }
  if (parents.length === 2 && parents[1] === recorded) {
    const forkParent = parents[0] as string;
    if (mergeTree(forkParent, recorded).tree !== tree) return "foreign";
    return gitOk(["merge-base", "--is-ancestor", forkParent, fork]) ? "pure" : "stale";
  }
  return "foreign";
}

/** The upstream commit named by the newest fork-kit merge in the fork's history, if fork-kit merged before. */
function lastMergedUpstream(fork: string): string | null {
  const value = git(
    ["log", "-n", "1", "--grep", `^${TRAILER}: `, `--format=%(trailers:key=${TRAILER},valueonly)`, fork],
    {
      check: false,
    },
  ).trim();
  if (!/^[0-9a-f]{40,64}$/.test(value) || !gitOk(["cat-file", "-e", `${value}^{commit}`])) return null;
  return value;
}

export async function plan(m: Manifest, forge: Forge): Promise<Plan> {
  const [major, minor] = gitVersion();
  if (major < MIN_GIT[0] || (major === MIN_GIT[0] && minor < MIN_GIT[1])) {
    throw new Failure(`git >= ${MIN_GIT.join(".")} is required`);
  }
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    throw new Failure("this is a shallow clone; fork-kit needs full history (actions/checkout with fetch-depth: 0)");
  }
  const [ref, up] = await resolveUpstream(m, forge);
  const [fork, sync] = fetchFork(m);
  const syncState: SyncState = sync === null ? "none" : classifySync(sync, fork, up);
  const base0 = { upstreamRef: ref, upstreamSha: up, forkSha: fork, syncSha: sync, syncState, notes: [] as string[] };
  if (gitOk(["merge-base", "--is-ancestor", up, fork])) {
    return {
      ...base0,
      outcome: "up-to-date",
      base: git(["merge-base", fork, up]),
      behind: 0,
      conflicts: [],
      workflowChanges: [],
    };
  }
  const base = git(["merge-base", fork, up], { check: false });
  if (!base) mergeTree(fork, up); // throws the unrelated-histories message
  const behind = revList(up, `^${fork}`).length;
  const workflowChanges = gitPaths(["diff", "--name-only", "--no-renames", base, up, "--", ".github"]);
  const conflicts = mergeTree(fork, up).conflicts.map((path) => ({ path, patches: patchesFor(m, path) }));
  if (conflicts.length) {
    // A conflict pushes upstream's tree as it is, so upstream's version of every workflow the fork changed
    // runs on the sync branch too, not only the files upstream changed.
    const forkChanged = gitPaths([
      "diff",
      "--name-only",
      "--no-renames",
      "--diff-filter=AM",
      fork,
      up,
      "--",
      ".github",
    ]);
    workflowChanges.push(...forkChanged.filter((f) => !workflowChanges.includes(f)));
    workflowChanges.sort();
  }
  let outcome: Outcome = conflicts.length ? "conflict" : "clean";
  if (syncState === "foreign") outcome = "hands-off";
  // The upstream merged last must be part of the new one: a backport release marked latest, a force-pushed
  // branch or a moved tag would otherwise merge an older line into the fork.
  const last = lastMergedUpstream(fork);
  if (last && !gitOk(["merge-base", "--is-ancestor", last, up])) {
    return {
      ...base0,
      outcome: "diverged",
      base,
      behind,
      conflicts: [],
      workflowChanges: [],
      notes: [
        `upstream ${ref} (${up.slice(0, 8)}) does not contain ${last.slice(0, 8)}, the upstream ${m.branch} last merged; nothing pushed`,
      ],
    };
  }
  const p: Plan = { ...base0, outcome, base, behind, conflicts, workflowChanges };
  if (syncState === "stale") {
    p.notes.push(`the sync branch was built on a ${m.branch} commit that is no longer on ${m.branch}; rebuilding`);
  }
  return p;
}
