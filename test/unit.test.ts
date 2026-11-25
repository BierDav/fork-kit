// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubForge, summarizeChecks } from "../src/forge.ts";
import { Failure } from "../src/git.ts";
import { loadManifest } from "../src/manifest.ts";
import { githubSlug, globMatch, md, naturalCompare } from "../src/text.ts";

describe("text", () => {
  test("globs", () => {
    expect(globMatch("src/**", "src/a/b.rs")).toBe(true);
    expect(globMatch("**/*.rs", "a.rs")).toBe(true);
    expect(globMatch("**/*.rs", "x/y/a.rs")).toBe(true);
    expect(globMatch("src/*.rs", "src/a.rs")).toBe(true);
    expect(globMatch("src/*.rs", "src/x/a.rs")).toBe(false);
    expect(globMatch("src/a.rs", "src/a.rsx")).toBe(false);
    expect(globMatch("src/a.rs", "srcXa.rs")).toBe(false);
  });

  test("natural order", () => {
    expect(["v1.9", "v1.10", "v1.2"].sort(naturalCompare)).toEqual(["v1.2", "v1.9", "v1.10"]);
    // Beyond Number's precision: these differ only in the last digit.
    expect(["v20261125000000000002", "v20261125000000000001"].sort(naturalCompare)).toEqual([
      "v20261125000000000001",
      "v20261125000000000002",
    ]);
  });

  test("github slugs", () => {
    expect(githubSlug("https://github.com/a/b.git")).toBe("a/b");
    expect(githubSlug("git@github.com:a/b")).toBe("a/b");
    expect(githubSlug("https://gitlab.com/a/b")).toBeNull();
  });

  test("markdown escaping", () => {
    expect(md("a|b`c\nd<!--")).toBe("a\\|b\\`c d\\<\\!\\-\\-");
  });

  test("check summaries", () => {
    expect(summarizeChecks([])).toBe("unknown");
    expect(
      summarizeChecks([
        ["completed", "success"],
        ["completed", "skipped"],
      ]),
    ).toBe("success");
    expect(
      summarizeChecks([
        ["completed", "success"],
        ["in_progress", null],
      ]),
    ).toBe("pending");
    expect(
      summarizeChecks([
        ["in_progress", null],
        ["completed", "failure"],
      ]),
    ).toBe("failure");
  });
});

describe("manifest", () => {
  test("reports every problem at once", () => {
    const dir = mkdtempSync(join(tmpdir(), "fork-kit-m-"));
    try {
      const p = join(dir, "m.toml");
      writeFileSync(
        p,
        `[upstream]\ntrack = "sometimes"\n[fork]\nbranch = "x"\nsync_branch = "x"\nworkflow_changes = "maybe"\nauto_merge = false\n[[patch]]\nid = "Bad Id"\n`,
      );
      let msg = "";
      try {
        loadManifest(p);
      } catch (e) {
        expect(e).toBeInstanceOf(Failure);
        msg = (e as Error).message;
      }
      for (const needle of [
        "url is required",
        "track must be",
        "sync_branch must differ",
        "workflow_changes must be",
        "id must match",
        "paths is required",
        "[fork]: unknown keys auto_merge",
      ]) {
        expect(msg).toContain(needle);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("GitHubForge against a mock API", () => {
  // biome-ignore lint/suspicious/noExplicitAny: the mock answers free-form JSON
  type Handler = (req: Request, url: URL) => any;
  const routes = new Map<string, Handler>();
  const seen: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const key = `${req.method} ${url.pathname}`;
        seen.push(`${key}${url.search}`);
        const h = routes.get(key);
        if (!h) return Response.json({ message: `no route ${key}` }, { status: 404 });
        const out = await h(req, url);
        if (out instanceof Response) return out;
        return Response.json(out);
      },
    });
    base = `http://localhost:${server.port}`;
  });
  afterAll(() => server.stop(true));

  test("checks combine paginated runs and statuses, skipping fork-kit's own runs", async () => {
    process.env.GITHUB_WORKFLOW_REF = "o/r/.github/workflows/fork-kit.yml@refs/heads/main";
    routes.set("GET /repos/o/r/actions/runs", () => ({
      total_count: 2,
      workflow_runs: [
        { id: 7, path: ".github/workflows/fork-kit.yml" },
        { id: 8, path: ".github/workflows/ci.yml" },
      ],
    }));
    routes.set("GET /repos/o/r/commits/abc/check-runs", (_req, url) => {
      if (url.searchParams.get("page") === "2") {
        return {
          total_count: 2,
          check_runs: [{ status: "completed", conclusion: "success", details_url: "x/actions/runs/8/job/2" }],
        };
      }
      return Response.json(
        {
          total_count: 2,
          check_runs: [{ status: "completed", conclusion: "failure", details_url: "x/actions/runs/7/job/1" }],
        },
        { headers: { link: `<${base}/repos/o/r/commits/abc/check-runs?per_page=100&page=2>; rel="next"` } },
      );
    });
    routes.set("GET /repos/o/r/commits/abc/status", () => ({ state: "success", statuses: [{ state: "success" }] }));
    const forge = new GitHubForge("o/r", "t", base);
    expect(await forge.checks("abc")).toBe("success");
    expect(seen.some((s) => s.includes("check-runs") && s.includes("page=2"))).toBe(true);

    routes.set("GET /repos/o/r/commits/abc/status", () => ({ state: "failure", statuses: [{ state: "error" }] }));
    expect(await forge.checks("abc")).toBe("failure");

    routes.delete("GET /repos/o/r/commits/abc/status");
    expect(await forge.checks("abc")).toBe("error");
    delete process.env.GITHUB_WORKFLOW_REF;
  });

  test("auto-merge goes through GraphQL and reports failures", async () => {
    routes.set("GET /repos/o/r/pulls/3", () => ({ number: 3, node_id: "PR_3" }));
    let body = "";
    routes.set("POST /graphql", async (req: Request) => {
      body = await req.text();
      return { errors: [{ message: "Pull request is in clean status" }] };
    });
    const forge = new GitHubForge("o/r", "t", base);
    expect(await forge.automerge(3, true)).toContain("clean status");
    expect(body).toContain("enablePullRequestAutoMerge");
    expect(body).toContain("PR_3");
  });

  test("labels tolerate existing labels and labels already removed", async () => {
    routes.set("POST /repos/o/r/labels", () => Response.json({ message: "exists" }, { status: 422 }));
    routes.set("POST /repos/o/r/issues/3/labels", () => []);
    routes.set("DELETE /repos/o/r/issues/3/labels/fork-kit:conflict", () =>
      Response.json({ message: "gone" }, { status: 404 }),
    );
    const forge = new GitHubForge("o/r", "t", base);
    await forge.labels(3, ["fork-kit:needs-owner"], ["fork-kit:conflict"]);
    expect(seen).toContain("POST /repos/o/r/issues/3/labels");
  });

  test("finding the sync PR", async () => {
    routes.set("GET /repos/o/r/pulls", (_req, url) => {
      expect(url.searchParams.get("head")).toBe("o:fork-kit/sync");
      return [{ number: 5, html_url: "https://x/pull/5", labels: [{ name: "fork-kit:hold" }], auto_merge: { x: 1 } }];
    });
    const forge = new GitHubForge("o/r", "t", base);
    expect(await forge.findPr("fork-kit/sync", "patched")).toEqual({
      number: 5,
      url: "https://x/pull/5",
      labels: ["fork-kit:hold"],
      automerge: true,
    });
  });
});
