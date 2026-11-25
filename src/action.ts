// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

// The GitHub Action entry point: maps the action's inputs onto the CLI.

import { resolve } from "node:path";
import { main } from "./cli.ts";

function input(name: string, fallback = ""): string {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim() || fallback;
}

const command = input("command", "sync");
if (!["sync", "guard", "status", "ledger"].includes(command)) {
  process.stdout.write(`::error::fork-kit: unknown command ${command}\n`);
  process.exit(2);
}
const token = input("token");
if (!token) {
  process.stdout.write("::error::fork-kit: the token input is required\n");
  process.exit(2);
}
process.stdout.write(`::add-mask::${token}\n`);
process.env.GH_TOKEN = token;
process.env.FORK_KIT_GIT_NAME = input("git-user-name", "fork-kit[bot]");
process.env.FORK_KIT_GIT_EMAIL = input("git-user-email", "fork-kit[bot]@users.noreply.github.com");

// Central mode: one workflow syncs a fork checked out into working-directory. The
// report path stays relative to the workspace then, so upload-artifact finds it.
const dir = input("working-directory");
const report = dir ? resolve(input("report", "fork-kit-result.json")) : input("report", "fork-kit-result.json");
if (dir) process.chdir(dir);
const workflow = input("workflow");
if (workflow) process.env.FORK_KIT_WORKFLOW = workflow;

const args = ["--manifest", input("manifest", ".fork-kit.toml"), "--report", report];
const repository = input("repository");
if (repository) args.unshift("--repo", repository);
args.push(command);
if (input("dry-run") === "true" && (command === "sync" || command === "guard")) args.push("--dry-run");
if (input("allow-workflow-changes") === "true" && command === "sync") args.push("--allow-workflow-changes");
if (input("strict") === "true" && command === "ledger") args.push("--strict");

const code = await main(args);
if (code !== 0) process.stdout.write(`::error::fork-kit ${command} exited ${code}\n`);
process.exitCode = code;
