// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  type CheckState,
  type Forge,
  LABEL_CONFLICT,
  LABEL_HOLD,
  LABEL_OWNER,
  LABEL_WORKFLOWS,
  type PR,
  STATUS_HOLD,
} from "./forge.ts";
import { Failure, git, gitOk, gitPaths, mergeTree, parentsOf, trailerValue } from "./git.ts";
import type { Manifest } from "./manifest.ts";
import { type Conflict, identity, type Outcome, type Plan, plan, type SyncState, TRAILER } from "./plan.ts";
import { githubSlug, globMatch, md, patchesFor } from "./text.ts";

export const VERSION = "0.3.0";
export const SCHEMA = 1;
const MARKER = "<!-- fork-kit -->";

export interface Options {
  dryRun?: boolean;
  allowWorkflowChanges?: boolean;
  strict?: boolean;
}

export interface Result {
  schema: number;
  tool: string;
  command: string;
  outcome: Outcome;
  upstream?: { url: string; track: string; ref: string; sha: string };
  fork?: { branch: string; sha: string };
  base?: string | null;
  behind?: number;
  conflicts: Conflict[];
  workflow_changes: string[];
  sync_branch?: { name: string; sha: string | null; state: SyncState };
  pr: { number: number; url: string } | null;
  automerge: boolean;
  automerge_blocked_by?: string[];
  baseline?: CheckState;
  ledger?: { changed: number; uncovered: string[]; stale: string[] };
  notes: string[];
  exit?: number;
}

function reportBase(command: string, m: Manifest, p: Plan): Result {
  return {
    schema: SCHEMA,
    tool: `fork-kit ${VERSION}`,
    command,
    outcome: p.outcome,
    upstream: { url: m.upstreamUrl, track: m.track, ref: p.upstreamRef, sha: p.upstreamSha },
    fork: { branch: m.branch, sha: p.forkSha },
    base: p.base || null,
    behind: p.behind,
    conflicts: p.conflicts,
    workflow_changes: p.workflowChanges,
    sync_branch: { name: m.syncBranch, sha: p.syncSha, state: p.syncState },
    pr: null,
    automerge: false,
    notes: [...p.notes],
  };
}

const prRef = (pr: PR) => ({ number: pr.number, url: pr.url });

/** The commit the sync branch should point at: the merge, or upstream plus a marker when it conflicts. */
function buildSyncCommit(m: Manifest, p: Plan): string {
  let tree: string;
  let parents: string[];
  let head: string;
  if (p.outcome === "clean") {
    tree = mergeTree(p.forkSha, p.upstreamSha).tree as string;
    parents = ["-p", p.forkSha, "-p", p.upstreamSha];
    head = `Merge upstream ${p.upstreamRef} into ${m.branch}`;
  } else {
    tree = git(["rev-parse", `${p.upstreamSha}^{tree}`]);
    parents = ["-p", p.upstreamSha];
    head = `Upstream ${p.upstreamRef} for ${m.branch} (conflicts: resolve by merging ${m.branch} here)`;
  }
  const msg = `${head}\n\nUpstream: ${m.upstreamUrl} ${p.upstreamRef}\n\n${TRAILER}: ${p.upstreamSha}\n`;
  return git(["commit-tree", tree, ...parents, "-F", "-"], { env: identity(), input: msg });
}

/** Is the existing sync branch already what this plan would push? */
function syncCurrent(p: Plan): boolean {
  if (p.syncState !== "pure" || !p.syncSha || trailerValue(p.syncSha, TRAILER) !== p.upstreamSha) return false;
  const want = p.outcome === "clean" ? [p.forkSha, p.upstreamSha] : [p.upstreamSha];
  return parentsOf(p.syncSha).join(" ") === want.join(" ");
}

function prBody(m: Manifest, p: Plan, baseline: CheckState, automerge: boolean, whyNot: string[]): string {
  const slug = githubSlug(m.upstreamUrl);
  let range = `\`${p.base.slice(0, 8)}..${p.upstreamSha.slice(0, 8)}\``;
  if (slug) range = `[${range}](https://github.com/${slug}/compare/${p.base}...${p.upstreamSha})`;
  const lines = [
    MARKER,
    `Merges upstream **${p.upstreamRef}** into \`${m.branch}\`: ${range}, ${p.behind} new upstream commit(s).`,
    "",
  ];
  if (p.conflicts.length) {
    lines.push(
      "### Conflicts",
      "",
      "| Path | Patches |",
      "|---|---|",
      ...p.conflicts.map((c) => `| ${md(c.path)} | ${c.patches.join(", ") || "_not in the ledger_"} |`),
      "",
      `Resolve by merging \`${m.branch}\` into this branch (\`fork-kit resolve\`, or GitHub's conflict editor), ` +
        "keeping each patch's intent and its tests. Once you push, fork-kit stops updating this branch; " +
        "close the PR to let it start over.",
      "",
    );
  }
  if (p.workflowChanges.length) {
    lines.push("### Upstream changed workflows", "", ...p.workflowChanges.map((w) => `- ${md(w)}`), "");
  }
  lines.push(`Checks on \`${m.branch}\` (\`${p.forkSha.slice(0, 8)}\`): **${baseline}**.`);
  if (automerge) lines.push("fork-kit requests auto-merge: this merges once the required checks pass.");
  else if (whyNot.length) lines.push(`No auto-merge: ${whyNot.join("; ")}.`);
  return `${lines.join("\n")}\n`;
}

export async function sync(m: Manifest, forge: Forge, opts: Options): Promise<Result> {
  const p = await plan(m, forge);
  const result = reportBase("sync", m, p);
  if (p.outcome === "up-to-date") {
    result.notes.push("upstream is already merged");
    return result;
  }
  let pr = await forge.findPr(m.syncBranch, m.branch);

  if (p.outcome === "hands-off") {
    if (pr === null) {
      // Someone else's sync branch with no open PR: closed or abandoned. Start over.
      p.syncState = "stale";
      p.outcome = p.conflicts.length ? "conflict" : "clean";
      result.outcome = p.outcome;
      if (result.sync_branch) result.sync_branch.state = "stale";
      result.notes.push("the sync branch has commits fork-kit did not make and no open PR; starting over");
    } else {
      result.pr = prRef(pr);
      if (p.syncSha && gitOk(["merge-base", "--is-ancestor", p.upstreamSha, p.syncSha])) {
        result.notes.push("the hand-edited sync branch already contains this upstream");
      } else if (!opts.dryRun) {
        const tag = `<!-- fork-kit:upstream ${p.upstreamSha} -->`;
        if (!(await forge.comments(pr.number)).some((c) => c.includes(tag))) {
          await forge.comment(
            pr.number,
            `${tag}\nUpstream moved to **${p.upstreamRef}** (\`${p.upstreamSha.slice(0, 8)}\`). This branch has ` +
              "commits fork-kit did not make, so it leaves the branch alone: merge the new upstream here, " +
              "or close this PR to let fork-kit start over.",
          );
        }
      }
      if (!opts.dryRun) {
        if (pr.automerge) await forge.automerge(pr.number, false);
        if (!pr.labels.includes(LABEL_OWNER)) await forge.labels(pr.number, [LABEL_OWNER], []);
      }
      return result;
    }
  }

  if (p.workflowChanges.length && m.workflowChanges === "hold" && !opts.allowWorkflowChanges) {
    // Pushing these would make GitHub run upstream's new workflows in this repository.
    result.outcome = "workflow-review";
    result.notes.push(
      "upstream changed .github/; nothing pushed. Review the listed files, then run sync with " +
        "--allow-workflow-changes (the action's allow-workflow-changes input)",
    );
    return result;
  }

  const baseline = await forge.checks(p.forkSha);
  const whyNot: string[] = [];
  if (!m.automerge) whyNot.push("disabled in the manifest");
  if (pr?.labels.includes(LABEL_HOLD)) whyNot.push(`held with the ${LABEL_HOLD} label`);
  if (p.conflicts.length) whyNot.push("merge conflicts");
  if (p.workflowChanges.length) whyNot.push("upstream changed .github/");
  if (baseline === "failure") whyNot.push(`\`${m.branch}\` itself is failing its checks`);
  if (baseline === "error") whyNot.push(`could not read the checks of \`${m.branch}\``);
  const automerge = whyNot.length === 0;
  Object.assign(result, { baseline, automerge, automerge_blocked_by: whyNot });

  if (opts.dryRun) {
    result.notes.push("dry run: nothing pushed");
    return result;
  }

  if (!syncCurrent(p)) {
    const commit = buildSyncCommit(m, p);
    const lease = `--force-with-lease=refs/heads/${m.syncBranch}:${p.syncSha ?? ""}`;
    git(["push", "--quiet", lease, "origin", `${commit}:refs/heads/${m.syncBranch}`]);
    if (result.sync_branch) Object.assign(result.sync_branch, { sha: commit, state: "pure" });
    result.notes.push(`pushed ${m.syncBranch} at ${commit.slice(0, 8)}`);
  }

  const title = `fork-kit: merge upstream ${p.upstreamRef} (${p.upstreamSha.slice(0, 8)}) into ${m.branch}`;
  const body = prBody(m, p, baseline, automerge, whyNot);
  if (pr === null) pr = await forge.createPr(m.syncBranch, m.branch, title, body);
  else await forge.updatePr(pr.number, title, body);
  const want: [string, boolean][] = [
    [LABEL_CONFLICT, p.conflicts.length > 0],
    [LABEL_WORKFLOWS, p.workflowChanges.length > 0],
    [LABEL_OWNER, false],
  ];
  const labels = pr.labels;
  await forge.labels(
    pr.number,
    want.filter(([l, on]) => on && !labels.includes(l)).map(([l]) => l),
    want.filter(([l, on]) => !on && labels.includes(l)).map(([l]) => l),
  );
  if (pr.automerge !== automerge) {
    const err = await forge.automerge(pr.number, automerge);
    if (err) {
      result.automerge = pr.automerge;
      result.notes.push(`could not ${automerge ? "enable" : "disable"} auto-merge: ${err}`);
    }
  }
  result.pr = prRef(pr);
  return result;
}

/** On pushes to the sync PR: if anyone but fork-kit pushed, switch auto-merge off and keep out. */
/** The pull request a pull_request(_target) event is about, from the event payload. */
interface EventPr {
  number: number;
  headSha: string;
  headRef: string;
  baseRef: string;
  labels: string[];
  automerge: boolean;
}

export function eventPr(path = process.env.GITHUB_EVENT_PATH): EventPr | null {
  if (!path) return null;
  let event: unknown;
  try {
    event = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const pr = (event as { pull_request?: Record<string, unknown> } | null)?.pull_request;
  if (!pr || typeof pr.number !== "number") return null;
  const head = (pr.head ?? {}) as { sha?: unknown; ref?: unknown };
  const base = (pr.base ?? {}) as { ref?: unknown };
  if (typeof head.sha !== "string" || typeof head.ref !== "string" || typeof base.ref !== "string") return null;
  const labels = Array.isArray(pr.labels) ? pr.labels : [];
  return {
    number: pr.number,
    headSha: head.sha,
    headRef: head.ref,
    baseRef: base.ref,
    labels: labels.map((l) => (typeof l === "string" ? l : String((l as { name?: unknown })?.name ?? ""))),
    automerge: pr.auto_merge != null,
  };
}

/**
 * Runs on every pull request into the fork branch (pull_request_target: opened, synchronize, reopened,
 * labeled, unlabeled). It sets the fork-kit/hold status, failing while the PR has the hold label (and turns
 * auto-merge off then), so a ruleset that requires the status keeps a held PR from merging. On the sync PR
 * it also turns auto-merge off when someone other than fork-kit pushed to the sync branch.
 */
export async function guard(m: Manifest, forge: Forge, opts: Options): Promise<Result> {
  const event = eventPr();
  const notes: string[] = [];
  if (event && event.baseRef === m.branch) {
    const held = event.labels.includes(LABEL_HOLD);
    if (!opts.dryRun) {
      await forge.setStatus(
        event.headSha,
        held ? "failure" : "success",
        held ? `Held: remove the ${LABEL_HOLD} label to merge` : `Not held (add ${LABEL_HOLD} to hold)`,
      );
      if (held && event.automerge) await forge.automerge(event.number, false);
    }
    notes.push(
      held
        ? `#${event.number} is held with ${LABEL_HOLD}: ${STATUS_HOLD} fails and auto-merge is off`
        : `#${event.number} is not held: ${STATUS_HOLD} passes`,
    );
  }
  const headRef = event?.headRef ?? process.env.GITHUB_HEAD_REF;
  if (headRef && headRef !== m.syncBranch) {
    return {
      schema: SCHEMA,
      tool: `fork-kit ${VERSION}`,
      command: "guard",
      outcome: "not-sync-pr",
      conflicts: [],
      workflow_changes: [],
      pr: null,
      automerge: false,
      notes: [...notes, `${headRef} is not ${m.syncBranch}`],
    };
  }
  const p = await plan(m, forge);
  const result = reportBase("guard", m, p);
  result.notes.push(...notes);
  const pr = await forge.findPr(m.syncBranch, m.branch);
  if (pr === null || p.syncSha === null) {
    result.notes.push("no open sync PR");
    return result;
  }
  result.pr = prRef(pr);
  result.automerge = pr.automerge && !(event?.labels.includes(LABEL_HOLD) ?? false);
  if (p.syncState !== "foreign") {
    result.notes.push("the sync branch holds only fork-kit's commit");
    return result;
  }
  Object.assign(result, { outcome: "hands-off", automerge: false });
  if (!opts.dryRun) {
    if (pr.automerge) await forge.automerge(pr.number, false);
    if (!pr.labels.includes(LABEL_OWNER)) await forge.labels(pr.number, [LABEL_OWNER], []);
  }
  result.notes.push("someone else pushed to the sync branch: auto-merge off");
  return result;
}

export async function status(m: Manifest, forge: Forge): Promise<Result> {
  const p = await plan(m, forge);
  const result = reportBase("status", m, p);
  result.baseline = await forge.checks(p.forkSha);
  return result;
}

export async function ledger(m: Manifest, forge: Forge, opts: Options): Promise<Result> {
  const p = await plan(m, forge);
  const result = reportBase("ledger", m, p);
  const changed = p.base ? gitPaths(["diff", "--name-only", "--no-renames", p.base, p.forkSha]) : [];
  const counted = changed.filter((f) => !m.ignore.some((g) => globMatch(g, f)));
  const uncovered = counted.filter((f) => patchesFor(m, f).length === 0);
  const stale = m.patches
    .filter((pt) => !counted.some((f) => pt.paths.some((g) => globMatch(g, f))))
    .map((pt) => pt.id);
  result.ledger = { changed: counted.length, uncovered, stale };
  if (opts.strict && (uncovered.length || stale.length)) result.exit = 1;
  return result;
}

/** Locally: check out the sync branch and merge the fork into it, leaving conflicts to resolve. */
export async function resolve(m: Manifest, forge: Forge): Promise<Result> {
  if (git(["status", "--porcelain"])) throw new Failure("the working tree has changes; commit or stash them first");
  const p = await plan(m, forge);
  const result = reportBase("resolve", m, p);
  if (p.syncSha === null) throw new Failure(`origin has no ${m.syncBranch}; run fork-kit sync first`);
  git(["checkout", "--quiet", "-B", m.syncBranch, p.syncSha]);
  const merged = spawnSync("git", ["merge", "--no-ff", "--no-edit", p.forkSha], { encoding: "utf8" });
  if (merged.status === 0) {
    result.conflicts = [];
    result.notes.push(
      `merged ${m.branch} cleanly; review, test, then \`git push origin HEAD:refs/heads/${m.syncBranch}\``,
    );
    return result;
  }
  result.conflicts = gitPaths(["diff", "--name-only", "--diff-filter=U"]).map((path) => ({
    path,
    patches: patchesFor(m, path),
  }));
  const byId = new Map(m.patches.map((pt) => [pt.id, pt]));
  for (const c of result.conflicts) {
    console.log(`CONFLICT ${c.path}`);
    for (const id of c.patches) {
      const pt = byId.get(id);
      if (!pt) continue;
      console.log(`  patch ${id}: ${pt.summary}`);
      if (pt.tests.length) console.log(`    tests: ${pt.tests.join(", ")}`);
      if (pt.upstream !== "none") console.log(`    upstream: ${pt.upstream}`);
    }
  }
  result.notes.push(`resolve the conflicts, \`git commit\`, then \`git push origin HEAD:refs/heads/${m.syncBranch}\``);
  return result;
}
