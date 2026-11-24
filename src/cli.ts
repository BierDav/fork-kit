// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, writeFileSync } from "node:fs";
import { guard, ledger, type Options, type Result, resolve, status, sync, VERSION } from "./commands.ts";
import { makeForge } from "./forge.ts";
import { Failure } from "./git.ts";
import { loadManifest } from "./manifest.ts";
import { md } from "./text.ts";

const COMMANDS: Record<string, [help: string, flags: string[]]> = {
  status: ["show where the fork stands against upstream; changes nothing", []],
  sync: [
    "merge the newest upstream into the sync branch and keep its pull request current",
    ["--dry-run", "--allow-workflow-changes"],
  ],
  guard: ["switch auto-merge off when someone other than fork-kit pushed to the sync branch", ["--dry-run"]],
  ledger: ["check that the patch ledger covers every file the fork changes", ["--strict"]],
  resolve: ["locally: check out the sync branch and merge the fork into it to resolve conflicts", []],
};

const USAGE = `usage: fork-kit [--manifest PATH] [--report FILE] [--json] COMMAND [FLAGS]

Keep a downstream fork merged with its upstream through one sync pull request.

commands:
${Object.entries(COMMANDS)
  .map(([name, [help, flags]]) => `  ${`${name} ${flags.map((f) => `[${f}]`).join(" ")}`.padEnd(48)} ${help}`)
  .join("\n")}

options:
  --manifest PATH   the manifest (default: .fork-kit.toml)
  --report FILE     also write the JSON result to FILE
  --json            print the JSON result instead of a summary
  --version         print the version
`;

export function summaryMarkdown(r: Result): string {
  const lines = [`## fork-kit ${r.command}: ${r.outcome}`, ""];
  if (r.upstream && r.fork) {
    lines.push(
      `- Upstream: \`${r.upstream.url}\` **${r.upstream.ref}** \`${r.upstream.sha.slice(0, 8)}\` (${r.behind} commit(s) not in the fork)`,
      `- Fork: \`${r.fork.branch}\` \`${r.fork.sha.slice(0, 8)}\``,
    );
  }
  if (r.pr) lines.push(`- Sync PR: ${r.pr.url} (auto-merge ${r.automerge ? "requested" : "off"})`);
  for (const c of r.conflicts) lines.push(`- Conflict: ${md(c.path)} (${c.patches.join(", ") || "not in the ledger"})`);
  for (const w of r.workflow_changes) lines.push(`- Upstream workflow change: ${md(w)}`);
  if (r.ledger) {
    const lg = r.ledger;
    lines.push(
      `- Ledger: ${lg.changed} changed file(s); uncovered: ${lg.uncovered.length}; stale patches: ${lg.stale.join(", ") || "none"}`,
      ...lg.uncovered.map((f) => `  - not in any patch: ${md(f)}`),
    );
  }
  lines.push(...r.notes.map((n) => `- ${n}`));
  return `${lines.join("\n")}\n`;
}

function emit(r: Result, json: boolean, report: string | undefined): void {
  if (report) writeFileSync(report, `${JSON.stringify(r, null, 2)}\n`);
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : summaryMarkdown(r));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(r));
  if (process.env.GITHUB_OUTPUT) {
    const out = {
      outcome: r.outcome,
      "upstream-ref": r.upstream?.ref ?? "",
      "upstream-sha": r.upstream?.sha ?? "",
      "pr-url": r.pr?.url ?? "",
      automerge: String(r.automerge),
      report: report ?? "",
    };
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      Object.entries(out)
        .map(([k, v]) => `${k}=${v}\n`)
        .join(""),
    );
  }
}

/** Run fork-kit; returns the exit code (0 ok, 1 gaps or conflicts left, 2 error). */
export async function main(argv: string[]): Promise<number> {
  let manifest = ".fork-kit.toml";
  let report: string | undefined;
  let json = false;
  let command: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-h" || a === "--help") {
      process.stdout.write(USAGE);
      return 0;
    } else if (a === "--version") {
      process.stdout.write(`fork-kit ${VERSION}\n`);
      return 0;
    } else if (a === "--json") json = true;
    else if (a === "--manifest" || a === "--report") {
      const v = argv[++i];
      if (v === undefined) return usageError(`${a} needs a value`);
      if (a === "--manifest") manifest = v;
      else report = v;
    } else if (!command && !a.startsWith("-")) {
      if (!(a in COMMANDS)) return usageError(`unknown command ${a}`);
      command = a;
    } else if (command && COMMANDS[command]?.[1].includes(a)) flags.add(a);
    else return usageError(`unknown argument ${a}`);
  }
  if (!command) return usageError("a command is required");
  const opts: Options = {
    dryRun: flags.has("--dry-run"),
    allowWorkflowChanges: flags.has("--allow-workflow-changes"),
    strict: flags.has("--strict"),
  };
  let r: Result;
  try {
    const m = loadManifest(manifest);
    const forge = makeForge();
    if (command === "sync") r = await sync(m, forge, opts);
    else if (command === "guard") r = await guard(m, forge, opts);
    else if (command === "ledger") r = await ledger(m, forge, opts);
    else if (command === "resolve") r = await resolve(m, forge);
    else r = await status(m, forge);
  } catch (e) {
    process.stderr.write(`fork-kit: ${e instanceof Failure ? e.message : (e as Error).stack}\n`);
    return 2;
  }
  const code = r.exit ?? 0;
  delete r.exit;
  emit(r, json, report);
  if (command === "resolve" && r.conflicts.length) return 1;
  return code;
}

function usageError(msg: string): number {
  process.stderr.write(`fork-kit: ${msg}\n\n${USAGE}`);
  return 2;
}
