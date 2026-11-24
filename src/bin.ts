// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import { main } from "./cli.ts";

const [major = 0] = process.versions.node.split(".").map(Number);
if (major < 22) {
  process.stderr.write(`fork-kit needs Node.js >= 22 (this is ${process.versions.node})\n`);
  process.exit(2);
}
process.exitCode = await main(process.argv.slice(2));
