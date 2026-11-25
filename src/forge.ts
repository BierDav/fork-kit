// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { retry } from "@octokit/plugin-retry";
import { Octokit } from "@octokit/rest";
import { Failure, git } from "./git.ts";
import { githubSlug } from "./text.ts";

export interface PR {
  number: number;
  url: string;
  labels: string[];
  automerge: boolean;
}

export type CheckState = "success" | "failure" | "pending" | "unknown" | "error";

/** The few pull request operations fork-kit needs. */
export interface Forge {
  latestRelease(url: string): Promise<string>;
  findPr(head: string, base: string): Promise<PR | null>;
  createPr(head: string, base: string, title: string, body: string): Promise<PR>;
  updatePr(num: number, title: string, body: string): Promise<void>;
  labels(num: number, add: string[], remove: string[]): Promise<void>;
  /**
   * Turns auto-merge on or off; returns an error message, or null on success. Turning it on names the head
   * commit fork-kit checked, so GitHub refuses when someone pushed since.
   */
  automerge(num: number, enable: boolean, headSha?: string): Promise<string | null>;
  /** Merges now (merge commit), only if the head is still headSha; returns an error message, or null. */
  merge(num: number, headSha: string): Promise<string | null>;
  close(num: number, comment: string): Promise<void>;
  comments(num: number): Promise<string[]>;
  comment(num: number, body: string): Promise<void>;
  checks(sha: string): Promise<CheckState>;
  /** Sets fork-kit's own commit status (STATUS_HOLD) on a commit. */
  setStatus(sha: string, state: "success" | "failure", description: string): Promise<void>;
}

export const LABEL_CONFLICT = "fork-kit:conflict";
export const LABEL_WORKFLOWS = "fork-kit:workflow-change";
export const LABEL_OWNER = "fork-kit:needs-owner";
export const LABEL_HOLD = "fork-kit:hold";
/** The commit status the guard sets on every pull request into the fork branch; fails while it is held. */
export const STATUS_HOLD = "fork-kit/hold";
const LABELS: Record<string, [string, string]> = {
  [LABEL_CONFLICT]: ["b60205", "Merging upstream conflicts with the fork"],
  [LABEL_WORKFLOWS]: ["fbca04", "Upstream changed .github/; needs a human"],
  [LABEL_OWNER]: ["5319e7", "Someone else pushed to the sync branch; fork-kit keeps out"],
  [LABEL_HOLD]: ["d4c5f9", "Set by a human: the fork-kit/hold check fails, so the PR cannot merge"],
};

export function summarizeChecks(runs: [status: string, conclusion: string | null][]): CheckState {
  if (runs.length === 0) return "unknown";
  const bad = ["failure", "timed_out", "action_required", "startup_failure"];
  if (runs.some(([s, c]) => s === "completed" && c !== null && bad.includes(c))) return "failure";
  if (runs.some(([s]) => s !== "completed")) return "pending";
  return "success";
}

const RetryingOctokit = Octokit.plugin(retry);

function status(e: unknown): number | undefined {
  return typeof e === "object" && e !== null && "status" in e ? Number((e as { status: unknown }).status) : undefined;
}

export class GitHubForge implements Forge {
  readonly owner: string;
  readonly repo: string;
  private readonly octokit: InstanceType<typeof RetryingOctokit>;
  private labelsReady = false;

  constructor(slug: string, token: string | undefined, baseUrl?: string) {
    const [owner, repo] = slug.split("/");
    if (!owner || !repo) throw new Failure(`not a repository: ${slug}`);
    this.owner = owner;
    this.repo = repo;
    this.octokit = new RetryingOctokit({
      ...(token ? { auth: token } : {}),
      baseUrl: baseUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com",
      userAgent: "fork-kit",
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
  }

  private get r() {
    return { owner: this.owner, repo: this.repo };
  }

  private toPr(raw: {
    number: number;
    html_url: string;
    labels: ({ name?: string } | string)[];
    auto_merge?: unknown;
  }): PR {
    return {
      number: raw.number,
      url: raw.html_url,
      labels: raw.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
      automerge: raw.auto_merge != null,
    };
  }

  async latestRelease(url: string): Promise<string> {
    const [owner = "", repo = ""] = (githubSlug(url) ?? "").split("/");
    const { data } = await this.octokit.rest.repos.getLatestRelease({ owner, repo });
    return data.tag_name;
  }

  async findPr(head: string, base: string): Promise<PR | null> {
    const { data } = await this.octokit.rest.pulls.list({
      ...this.r,
      head: `${this.owner}:${head}`,
      base,
      state: "open",
      per_page: 1,
    });
    return data[0] ? this.toPr(data[0]) : null;
  }

  async createPr(head: string, base: string, title: string, body: string): Promise<PR> {
    const { data } = await this.octokit.rest.pulls.create({ ...this.r, head, base, title, body });
    return this.toPr(data);
  }

  async updatePr(num: number, title: string, body: string): Promise<void> {
    await this.octokit.rest.pulls.update({ ...this.r, pull_number: num, title, body });
  }

  async labels(num: number, add: string[], remove: string[]): Promise<void> {
    if (add.length && !this.labelsReady) {
      for (const [name, [color, description]] of Object.entries(LABELS)) {
        try {
          await this.octokit.rest.issues.createLabel({ ...this.r, name, color, description });
        } catch (e) {
          if (status(e) !== 422) throw e; // 422: it exists
        }
      }
      this.labelsReady = true;
    }
    if (add.length) await this.octokit.rest.issues.addLabels({ ...this.r, issue_number: num, labels: add });
    for (const name of remove) {
      try {
        await this.octokit.rest.issues.removeLabel({ ...this.r, issue_number: num, name });
      } catch (e) {
        if (status(e) !== 404) throw e;
      }
    }
  }

  async automerge(num: number, enable: boolean, headSha?: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.pulls.get({ ...this.r, pull_number: num });
      if (enable) {
        await this.octokit.graphql(
          "mutation($id: ID!, $head: GitObjectID) { enablePullRequestAutoMerge(input: " +
            "{pullRequestId: $id, mergeMethod: MERGE, expectedHeadOid: $head}) { clientMutationId } }",
          { id: data.node_id, head: headSha ?? null },
        );
      } else {
        await this.octokit.graphql(
          "mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { clientMutationId } }",
          { id: data.node_id },
        );
      }
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async merge(num: number, headSha: string): Promise<string | null> {
    try {
      await this.octokit.rest.pulls.merge({ ...this.r, pull_number: num, sha: headSha, merge_method: "merge" });
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async close(num: number, comment: string): Promise<void> {
    await this.comment(num, comment);
    await this.octokit.rest.pulls.update({ ...this.r, pull_number: num, state: "closed" });
  }

  async comments(num: number): Promise<string[]> {
    const all = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      ...this.r,
      issue_number: num,
      per_page: 100,
    });
    return all.map((c) => c.body ?? "");
  }

  async comment(num: number, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ ...this.r, issue_number: num, body });
  }

  /**
   * The fork's workflow that runs fork-kit, so its own jobs don't count as the fork's checks:
   * FORK_KIT_WORKFLOW (a path in the fork, set when fork-kit runs from another repository),
   * else the workflow running now if it belongs to the fork.
   */
  private ownWorkflow(): string | undefined {
    if (process.env.FORK_KIT_WORKFLOW) return process.env.FORK_KIT_WORKFLOW;
    const m = /^([^/]+)\/([^/]+)\/(.+?)@/.exec(process.env.GITHUB_WORKFLOW_REF ?? "");
    if (!m) return undefined;
    const same = `${m[1]}/${m[2]}`.toLowerCase() === `${this.owner}/${this.repo}`.toLowerCase();
    return same ? m[3] : undefined;
  }

  /** Runs of the workflow fork-kit itself runs in (see ownWorkflow). */
  private async ownRuns(sha: string): Promise<Set<number>> {
    const path = this.ownWorkflow();
    if (!path) return new Set();
    const runs = await this.octokit.paginate(this.octokit.rest.actions.listWorkflowRunsForRepo, {
      ...this.r,
      head_sha: sha,
      per_page: 100,
    });
    return new Set(runs.filter((r) => r.path === path).map((r) => r.id));
  }

  async checks(sha: string): Promise<CheckState> {
    try {
      const own = await this.ownRuns(sha);
      const runs = await this.octokit.paginate(this.octokit.rest.checks.listForRef, {
        ...this.r,
        ref: sha,
        per_page: 100,
      });
      const { data: combined } = await this.octokit.rest.repos.getCombinedStatusForRef({
        ...this.r,
        ref: sha,
        per_page: 100,
      });
      const ownUrls = [...own].map((id) => `/actions/runs/${id}/`);
      const items: [string, string | null][] = runs
        .filter((r) => !ownUrls.some((u) => (r.details_url ?? "").includes(u)))
        .map((r) => [r.status, r.conclusion]);
      // More statuses than one page: fall back to GitHub's combined state for all of them.
      if (combined.total_count > combined.statuses.length) {
        items.push(
          combined.state === "success"
            ? ["completed", "success"]
            : combined.state === "pending"
              ? ["queued", null]
              : ["completed", "failure"],
        );
      }
      for (const s of combined.statuses) {
        if (s.context === STATUS_HOLD) continue;
        if (s.state === "failure" || s.state === "error") items.push(["completed", "failure"]);
        else if (s.state === "success") items.push(["completed", "success"]);
        else items.push(["queued", null]);
      }
      return summarizeChecks(items);
    } catch {
      return "error";
    }
  }

  async setStatus(sha: string, state: "success" | "failure", description: string): Promise<void> {
    await this.octokit.rest.repos.createCommitStatus({ ...this.r, sha, state, context: STATUS_HOLD, description });
  }
}

interface FakePr extends PR {
  head: string;
  base: string;
  title: string;
  body: string;
  comments: string[];
  state: string;
  /** Test hook: GitHub would refuse auto-merge because the PR can already merge. */
  clean?: boolean;
}

interface FakeState {
  prs: FakePr[];
  calls: unknown[];
  releases?: Record<string, string>;
  checks?: Record<string, CheckState>;
  statuses?: Record<string, string>;
  /** Test hook: every auto-merge call fails. */
  failAutomerge?: boolean;
}

/** A forge kept in a JSON file, for tests and local experiments. */
export class FakeForge implements Forge {
  private readonly state: FakeState;

  constructor(private readonly path: string) {
    const raw = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Partial<FakeState>) : {};
    this.state = { ...raw, prs: raw.prs ?? [], calls: raw.calls ?? [] };
  }

  private save(call: string, extra: Record<string, unknown> = {}) {
    this.state.calls.push({ call, ...extra });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }

  private get(num: number): FakePr {
    const pr = this.state.prs.find((p) => p.number === num);
    if (!pr) throw new Failure(`fake forge: no PR ${num}`);
    return pr;
  }

  async latestRelease(url: string) {
    const tag = this.state.releases?.[url];
    if (!tag) throw new Failure(`fake forge: no release for ${url}`);
    return tag;
  }

  async findPr(head: string, base: string) {
    return this.state.prs.find((p) => p.head === head && p.base === base && p.state === "open") ?? null;
  }

  async createPr(head: string, base: string, title: string, body: string) {
    const num = this.state.prs.length + 1;
    const pr: FakePr = {
      number: num,
      url: `fake://pr/${num}`,
      head,
      base,
      title,
      body,
      labels: [],
      automerge: false,
      comments: [],
      state: "open",
    };
    this.state.prs.push(pr);
    this.save("create_pr", { number: num });
    return pr;
  }

  async updatePr(num: number, title: string, body: string) {
    Object.assign(this.get(num), { title, body });
    this.save("update_pr", { number: num });
  }

  async labels(num: number, add: string[], remove: string[]) {
    const pr = this.get(num);
    pr.labels = [...new Set([...pr.labels, ...add])].filter((l) => !remove.includes(l)).sort();
    this.save("labels", { number: num, add, remove });
  }

  async automerge(num: number, enable: boolean, headSha?: string) {
    const pr = this.get(num);
    if (this.state.failAutomerge) {
      this.save("automerge", { number: num, enable, headSha, error: "forced failure" });
      return "forced failure";
    }
    if (enable && pr.clean) {
      this.save("automerge", { number: num, enable, headSha, error: "clean status" });
      return "Pull request is in clean status";
    }
    pr.automerge = enable;
    this.save("automerge", { number: num, enable, headSha });
    return null;
  }

  async merge(num: number, headSha: string) {
    this.get(num).state = "merged";
    this.save("merge", { number: num, headSha });
    return null;
  }

  async close(num: number, comment: string) {
    const pr = this.get(num);
    pr.comments.push(comment);
    pr.state = "closed";
    this.save("close", { number: num });
  }

  async comments(num: number) {
    return [...this.get(num).comments];
  }

  async comment(num: number, body: string) {
    this.get(num).comments.push(body);
    this.save("comment", { number: num });
  }

  async checks(sha: string) {
    return this.state.checks?.[sha] ?? "unknown";
  }

  async setStatus(sha: string, state: "success" | "failure", description: string) {
    this.state.statuses = { ...this.state.statuses, [sha]: state };
    this.save("status", { sha, state, description });
  }
}

function localToken(): string | undefined {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  const gh = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return gh.status === 0 && gh.stdout.trim() ? gh.stdout.trim() : undefined;
}

/**
 * The fork's repository: --repo, else FORK_KIT_REPOSITORY, else GITHUB_REPOSITORY, else origin.
 * --repo and FORK_KIT_REPOSITORY let one workflow sync forks in other repositories.
 */
export function makeForge(repo?: string): Forge {
  const spec = process.env.FORK_KIT_FORGE ?? "github";
  if (spec.startsWith("fake:")) return new FakeForge(spec.slice(5));
  if (spec !== "github") throw new Failure(`unknown FORK_KIT_FORGE ${JSON.stringify(spec)}`);
  const slug =
    repo ||
    process.env.FORK_KIT_REPOSITORY ||
    process.env.GITHUB_REPOSITORY ||
    githubSlug(git(["remote", "get-url", "origin"]));
  if (!slug) throw new Failure("origin is not a github.com repository; pass --repo OWNER/NAME");
  return new GitHubForge(slug, localToken());
}
