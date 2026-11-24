// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import type { Manifest } from "./manifest.ts";

/** Ref names fork-kit accepts: they appear in commit messages, PR titles and markdown. */
export const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/;

export function githubSlug(url: string): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
    url,
  );
  return m?.[1] ?? null;
}

/** Match a repo path against a glob where ** crosses directories and * does not. */
export function globMatch(pattern: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (pattern[i] === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += (pattern[i] as string).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`, "s").test(path);
}

export function patchesFor(m: Manifest, path: string): string[] {
  return m.patches.filter((p) => p.paths.some((g) => globMatch(g, path))).map((p) => p.id);
}

/** Escape text from git (paths, refs) for markdown, so it can't break tables or hide content. */
export function md(text: string): string {
  return text.replace(/[\r\n]/g, " ").replace(/[\\`*_{}[\]<>()#+\-.!|~]/g, "\\$&");
}

/** Natural order: v1.10 sorts after v1.9. */
export function naturalCompare(a: string, b: string): number {
  const split = (s: string) => s.split(/(\d+)/).filter((t) => t !== "");
  const ta = split(a);
  const tb = split(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
