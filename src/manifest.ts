// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { parse } from "smol-toml";
import { Failure, git } from "./git.ts";
import { githubSlug, SAFE_REF } from "./text.ts";

export interface Patch {
  id: string;
  summary: string;
  paths: string[];
  tests: string[];
  upstream: string;
}

export interface Manifest {
  upstreamUrl: string;
  track: string;
  trackKind: "branch" | "tag" | "release";
  trackArg: string;
  branch: string;
  syncBranch: string;
  automerge: boolean;
  workflowChanges: "hold" | "push";
  ignore: string[];
  patches: Patch[];
  path: string;
}

type Table = Record<string, unknown>;

const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** The manifest's path inside the repository, so the ledger never counts it as a change. */
function repoPath(path: string): string {
  const top = git(["rev-parse", "--show-toplevel"], { check: false });
  const rel = top ? relative(top, resolve(path)) : "";
  return rel && !rel.startsWith("..") ? rel.split("\\").join("/") : basename(path);
}

export function loadManifest(path: string): Manifest {
  if (!existsSync(path)) throw new Failure(`no manifest at ${path}`);
  let data: Table;
  try {
    data = parse(readFileSync(path, "utf8")) as Table;
  } catch (e) {
    throw new Failure(`${path}: ${(e as Error).message}`);
  }
  const errors: string[] = [];
  const str = (t: Table, key: string, where: string, fallback = ""): string => {
    const v = t[key] ?? fallback;
    if (typeof v !== "string") {
      errors.push(`${where} ${key} must be a string`);
      return fallback;
    }
    return v;
  };
  const up = isTable(data.upstream) ? data.upstream : {};
  const fork = isTable(data.fork) ? data.fork : {};
  // A misspelt key (auto_merge for automerge) must not silently fall back to a default.
  const known: [string, Table, string[]][] = [
    ["the top level", data, ["upstream", "fork", "ledger", "patch"]],
    ["[upstream]", up, ["url", "track"]],
    ["[fork]", fork, ["branch", "sync_branch", "automerge", "workflow_changes"]],
    ["[ledger]", isTable(data.ledger) ? data.ledger : {}, ["ignore"]],
  ];
  for (const [where, table, keys] of known) {
    const unknown = Object.keys(table).filter((k) => !keys.includes(k));
    if (unknown.length) errors.push(`${where}: unknown keys ${unknown.sort().join(", ")}`);
  }

  const url = str(up, "url", "[upstream]");
  const track = str(up, "track", "[upstream]");
  if (!url) errors.push("[upstream] url is required");
  const [kind = "", ...restArg] = track.split(":");
  const arg = restArg.join(":");
  if (kind !== "branch" && kind !== "tag" && kind !== "release") {
    errors.push('[upstream] track must be "branch:<name>", "tag:<regex>" or "release"');
  } else if (kind !== "release" && !track.includes(":")) {
    errors.push(`[upstream] track "${track}" needs an argument`);
  } else if (kind === "branch" && !SAFE_REF.test(arg)) {
    errors.push("[upstream] track branch name has unsupported characters");
  } else if (kind === "tag") {
    try {
      new RegExp(arg);
    } catch (e) {
      errors.push(`[upstream] track regex: ${(e as Error).message}`);
    }
  } else if (kind === "release" && githubSlug(url) === null) {
    errors.push('[upstream] track "release" needs a github.com url');
  }

  const branch = str(fork, "branch", "[fork]");
  if (!branch) errors.push("[fork] branch is required");
  else if (!SAFE_REF.test(branch)) errors.push("[fork] branch name has unsupported characters");
  const syncBranch = str(fork, "sync_branch", "[fork]", "fork-kit/sync");
  if (syncBranch === branch) errors.push("[fork] sync_branch must differ from branch");
  else if (!SAFE_REF.test(syncBranch)) errors.push("[fork] sync_branch name has unsupported characters");
  const workflowChanges = str(fork, "workflow_changes", "[fork]", "hold");
  if (workflowChanges !== "hold" && workflowChanges !== "push") {
    errors.push('[fork] workflow_changes must be "hold" or "push"');
  }
  const automerge = fork.automerge ?? true;
  if (typeof automerge !== "boolean") errors.push("[fork] automerge must be true or false");

  const patches: Patch[] = [];
  const seen = new Set<string>();
  const rawPatches = Array.isArray(data.patch) ? data.patch : [];
  rawPatches.forEach((raw, i) => {
    const t = isTable(raw) ? raw : {};
    const id = typeof t.id === "string" ? t.id : "";
    const name = id || String(i + 1);
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) errors.push(`[[patch]] #${i + 1}: id must match [a-z0-9][a-z0-9._-]*`);
    else if (seen.has(id)) errors.push(`[[patch]] ${id}: duplicate id`);
    seen.add(id);
    const paths = t.paths ?? [];
    const tests = t.tests ?? [];
    if (!isStrings(paths) || paths.length === 0) errors.push(`[[patch]] ${name}: paths is required (a list of globs)`);
    if (!isStrings(tests)) errors.push(`[[patch]] ${name}: tests must be a list of strings`);
    const unknown = Object.keys(t).filter((k) => !["id", "summary", "paths", "tests", "upstream"].includes(k));
    if (unknown.length) errors.push(`[[patch]] ${name}: unknown keys ${unknown.sort().join(", ")}`);
    patches.push({
      id,
      summary: typeof t.summary === "string" ? t.summary : "",
      paths: isStrings(paths) ? paths : [],
      tests: isStrings(tests) ? tests : [],
      upstream: typeof t.upstream === "string" ? t.upstream : "none",
    });
  });

  const ledger = isTable(data.ledger) ? data.ledger : {};
  const ignore = ledger.ignore ?? [];
  if (!isStrings(ignore)) errors.push("[ledger] ignore must be a list of globs");

  if (errors.length) throw new Failure(`${path}:\n  ${errors.join("\n  ")}`);
  return {
    upstreamUrl: url,
    track,
    trackKind: kind as Manifest["trackKind"],
    trackArg: arg,
    branch,
    syncBranch,
    automerge: automerge === true,
    workflowChanges: workflowChanges as Manifest["workflowChanges"],
    ignore: [...(isStrings(ignore) ? ignore : []), repoPath(path)],
    patches,
    path,
  };
}
