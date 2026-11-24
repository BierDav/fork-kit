// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

// The GitHub Action entry point: maps the action's inputs onto the CLI.

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

const args = ["--manifest", input("manifest", ".fork-kit.toml"), "--report", input("report", "fork-kit-result.json")];
args.push(command);
if (input("dry-run") === "true" && (command === "sync" || command === "guard")) args.push("--dry-run");
if (input("allow-workflow-changes") === "true" && command === "sync") args.push("--allow-workflow-changes");
if (input("strict") === "true" && command === "ledger") args.push("--strict");

const code = await main(args);
if (code !== 0) process.stdout.write(`::error::fork-kit ${command} exited ${code}\n`);
process.exitCode = code;
