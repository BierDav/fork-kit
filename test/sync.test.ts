// Copyright 2026 The fork-kit authors
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LABEL_CONFLICT, LABEL_HOLD, LABEL_OWNER, LABEL_WORKFLOWS } from "../src/forge.ts";
import { identity } from "../src/plan.ts";
import { commit, git, Repos, ROOT, run } from "./helpers.ts";

const BOT_EMAIL = identity().GIT_COMMITTER_EMAIL as string;

describe("sync", () => {
  let r: Repos;
  beforeEach(() => {
    r = new Repos();
  });
  afterEach(() => r.cleanup());

  test("does nothing when upstream is merged", () => {
    git(r.work, ["fetch", "-q", "upstream"]);
    git(r.work, ["merge", "-q", "--no-edit", "upstream/main"]);
    git(r.work, ["push", "-q", "origin", "patched"]);
    const [res] = r.cli(["sync"]);
    expect(res.outcome).toBe("up-to-date");
    expect(r.state().prs).toEqual([]);
    expect(r.syncSha()).toBe("");
  });

  test("a clean merge opens a PR with auto-merge, and a rerun changes nothing", () => {
    const up = commit(r.upstream, "src/new.txt", "new\n", "upstream: new file");
    const [res] = r.cli(["sync"]);
    expect(res.outcome).toBe("clean");
    const sync = r.syncSha();
    expect(r.parents(sync)).toEqual([r.sha("refs/heads/patched"), up]);
    expect(git(r.origin, ["log", "-1", "--format=%B", sync])).toContain(`Fork-Kit-Upstream: ${up}`);
    expect(git(r.origin, ["log", "-1", "--format=%ce", sync])).toBe(BOT_EMAIL);
    expect(git(r.origin, ["show", `${sync}:src/hello.txt`])).toBe("hallo\nworld");
    expect(git(r.origin, ["show", `${sync}:src/new.txt`])).toBe("new");
    const [pr] = r.state().prs;
    expect(pr?.automerge).toBe(true);
    expect(pr?.labels).toEqual([]);
    expect(pr?.body).toContain("1 new upstream commit");

    const [res2] = r.cli(["sync"]);
    expect(r.syncSha()).toBe(sync);
    expect(r.state().prs).toHaveLength(1);
    expect(res2.automerge).toBe(true);
  });

  test("conflicts map files to patches; the label goes once they're gone", () => {
    const up = commit(r.upstream, "src/hello.txt", "hi\nworld\n", "upstream: hi");
    const [res] = r.cli(["sync"]);
    expect(res.outcome).toBe("conflict");
    expect(res.conflicts).toEqual([{ path: "src/hello.txt", patches: ["greeting"] }]);
    expect(r.parents(r.syncSha())).toEqual([up]);
    let [pr] = r.state().prs;
    expect(pr?.labels).toEqual([LABEL_CONFLICT]);
    expect(pr?.automerge).toBe(false);
    expect(pr?.body).toContain("| src/hello\\.txt | greeting |");

    commit(r.upstream, "src/hello.txt", "hello\nworld\n", "upstream: revert");
    const [res2] = r.cli(["sync"]);
    expect(res2.outcome).toBe("clean");
    [pr] = r.state().prs;
    expect(pr?.labels).toEqual([]);
    expect(pr?.automerge).toBe(true);
  });

  test("unicode paths are reported verbatim", () => {
    const name = "src/extra/grüße file.txt";
    commit(r.upstream, name, "a\n", "upstream: unicode");
    r.pushFork(name, "b\n", "fork: unicode");
    const [res] = r.cli(["sync"]);
    expect(res.conflicts).toEqual([{ path: name, patches: ["extra"] }]);
  });

  test("upstream workflow changes are held until allowed", () => {
    commit(r.upstream, ".github/workflows/ci.yml", "on: push\n", "upstream: ci");
    const [res] = r.cli(["sync"]);
    expect(res.outcome).toBe("workflow-review");
    expect(res.workflow_changes).toEqual([".github/workflows/ci.yml"]);
    expect(r.syncSha()).toBe("");
    expect(r.state().prs).toEqual([]);

    const [res2] = r.cli(["sync", "--allow-workflow-changes"]);
    expect(res2.outcome).toBe("clean");
    expect(r.syncSha()).not.toBe("");
    const [pr] = r.state().prs;
    expect(pr?.automerge).toBe(false);
    expect(pr?.labels).toEqual([LABEL_WORKFLOWS]);
  });

  test("failing or unreadable checks block auto-merge", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    const fork = r.sha("refs/heads/patched");
    for (const [state, reason] of [
      ["failure", "is failing its checks"],
      ["error", "could not read the checks"],
    ] as const) {
      r.editState((s) => {
        s.checks = { [fork]: state };
      });
      const [res] = r.cli(["sync", "--dry-run"]);
      expect(res.automerge).toBe(false);
      expect(res.automerge_blocked_by.some((w: string) => w.includes(reason))).toBe(true);
    }
  });

  test("the hold label keeps auto-merge off", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    r.editState((s) => {
      Object.assign(s.prs[0] as object, { labels: [LABEL_HOLD], automerge: false });
    });
    commit(r.upstream, "src/new2.txt", "new\n", "upstream: new2");
    const [res] = r.cli(["sync"]);
    expect(res.automerge).toBe(false);
    expect(r.state().prs[0]?.automerge).toBe(false);
    expect(r.state().prs[0]?.labels).toContain(LABEL_HOLD);
  });

  test("a moving fork branch rebuilds the merge", () => {
    const up = commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    const first = r.syncSha();
    const fork2 = r.pushFork("src/extra/more.txt", "more\n", "fork: more");
    r.cli(["sync"]);
    expect(r.syncSha()).not.toBe(first);
    expect(r.parents(r.syncSha())).toEqual([fork2, up]);
  });

  test("a force-moved fork branch rebuilds instead of going hands-off", () => {
    const up = commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    git(r.work, ["checkout", "-q", "patched"]);
    git(r.work, ["commit", "-q", "--amend", "-m", "fork: manifest (reworded)"]);
    git(r.work, ["push", "-q", "--force", "origin", "patched"]);
    const rewritten = r.sha("refs/heads/patched");
    const [res] = r.cli(["sync"]);
    expect(res.outcome).toBe("clean");
    expect(r.parents(r.syncSha())).toEqual([rewritten, up]);
    expect(r.state().prs[0]?.labels).not.toContain(LABEL_OWNER);
  });

  test("a hand-edited sync branch is left alone until its PR closes", () => {
    commit(r.upstream, "src/hello.txt", "hi\nworld\n", "upstream: hi");
    r.cli(["sync"]);
    git(r.work, ["fetch", "-q", "origin"]);
    git(r.work, ["checkout", "-q", "-B", "fork-kit/sync", "origin/fork-kit/sync"]);
    run(r.work, ["git", "merge", "--no-edit", "origin/patched"], { check: false });
    writeFileSync(join(r.work, "src/hello.txt"), "hallo hi\nworld\n");
    git(r.work, ["commit", "-qam", "resolve"]);
    git(r.work, ["push", "-q", "origin", "fork-kit/sync"]);
    const human = r.syncSha();
    r.editState((s) => {
      (s.prs[0] as { automerge: boolean }).automerge = true;
    });

    const [res] = r.cli(["guard"]);
    expect(res.outcome).toBe("hands-off");
    expect(r.state().prs[0]?.automerge).toBe(false);
    expect(r.state().prs[0]?.labels).toContain(LABEL_OWNER);

    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    r.cli(["sync"]);
    expect(r.syncSha()).toBe(human);
    expect(r.state().prs[0]?.comments).toHaveLength(1);

    r.editState((s) => {
      (s.prs[0] as { state: string }).state = "closed";
    });
    const [res2] = r.cli(["sync"]);
    expect(res2.outcome).toBe("conflict");
    expect(r.syncSha()).not.toBe(human);
    expect(r.state().prs).toHaveLength(2);
  });

  test("an amended fork-kit commit counts as someone else's", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    git(r.work, ["fetch", "-q", "origin"]);
    git(r.work, ["checkout", "-q", "-B", "fork-kit/sync", "origin/fork-kit/sync"]);
    writeFileSync(join(r.work, "src/new.txt"), "changed by hand\n");
    git(r.work, ["add", "src/new.txt"]);
    // Even with the bot's identity and trailer kept, the tree gives it away.
    git(r.work, ["commit", "-q", "--amend", "--no-edit"], { env: { GIT_COMMITTER_EMAIL: BOT_EMAIL } });
    git(r.work, ["push", "-q", "--force", "origin", "fork-kit/sync"]);
    const amended = r.syncSha();
    const [res] = r.cli(["guard"]);
    expect(res.outcome).toBe("hands-off");
    r.pushFork("src/extra/more.txt", "more\n", "fork: more");
    r.cli(["sync"]);
    expect(r.syncSha()).toBe(amended);
  });

  test("after the sync PR merges, the next upstream starts a new round", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    git(r.work, ["fetch", "-q", "origin"]);
    git(r.work, ["checkout", "-q", "patched"]);
    git(r.work, ["reset", "-q", "--hard", "origin/patched"]);
    git(r.work, ["merge", "-q", "--no-ff", "--no-edit", "origin/fork-kit/sync"]);
    git(r.work, ["push", "-q", "origin", "patched"]);
    r.editState((s) => {
      (s.prs[0] as { state: string }).state = "merged";
    });
    expect(r.cli(["sync"])[0].outcome).toBe("up-to-date");
    const up2 = commit(r.upstream, "src/new2.txt", "new\n", "upstream: new2");
    const [res] = r.cli(["sync"]);
    expect(res.outcome).toBe("clean");
    expect(res.notes.at(-1)).toStartWith("pushed");
    expect(r.parents(r.syncSha())[1]).toBe(up2);
  });

  test("guard accepts fork-kit's own branch and ignores other PRs", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    const [res] = r.cli(["guard"]);
    expect(res.outcome).not.toBe("hands-off");
    expect(r.state().prs[0]?.automerge).toBe(true);
    expect(r.cli(["guard"], { env: { GITHUB_HEAD_REF: "feature" } })[0].outcome).toBe("not-sync-pr");
  });

  test("guard sets fork-kit/hold on every PR into the fork branch, failing while it is held", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    const sync = r.syncSha();
    const event = (labels: string[], head = "fork-kit/sync", sha = sync, base = "patched") => {
      const path = join(r.tmp, `event-${Math.random()}.json`);
      const pr = { number: 1, head: { ref: head, sha }, base: { ref: base }, labels: labels.map((name) => ({ name })) };
      writeFileSync(path, JSON.stringify({ pull_request: { ...pr, auto_merge: { merge_method: "merge" } } }));
      return { GITHUB_EVENT_PATH: path };
    };
    const statusCalls = () =>
      (r.state().calls as { call: string; sha?: string; state?: string }[]).filter((c) => c.call === "status");

    // Held: the status fails and auto-merge goes off.
    const [held] = r.cli(["guard"], { env: event([LABEL_HOLD]) });
    expect(statusCalls().at(-1)).toMatchObject({ sha: sync, state: "failure" });
    expect(r.state().prs[0]?.automerge).toBe(false);
    expect(held.automerge).toBe(false);

    // Unheld: the status passes; auto-merge stays off until sync requests it again.
    r.cli(["guard"], { env: event([]) });
    expect(statusCalls().at(-1)).toMatchObject({ sha: sync, state: "success" });
    expect(r.state().prs[0]?.automerge).toBe(false);
    expect(r.cli(["sync"])[0].automerge).toBe(true);

    // Any other PR into the fork branch gets the status too.
    const [other] = r.cli(["guard"], { env: event([LABEL_HOLD], "feature", "a".repeat(40)) });
    expect(other.outcome).toBe("not-sync-pr");
    expect(statusCalls().at(-1)).toMatchObject({ sha: "a".repeat(40), state: "failure" });

    // A PR into another branch is not fork-kit's business.
    const before = statusCalls().length;
    r.cli(["guard"], { env: event([LABEL_HOLD], "feature", "b".repeat(40), "main") });
    expect(statusCalls()).toHaveLength(before);
  });

  test("sync never requests auto-merge for a held PR", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    r.editState((s) => {
      (s.prs[0] as { labels: string[] }).labels = [LABEL_HOLD];
    });
    const [res] = r.cli(["sync"]);
    expect(res.automerge).toBe(false);
    expect(r.state().prs[0]?.automerge).toBe(false);
  });

  test("a forged fork-kit commit naming a non-upstream commit is someone else's", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    r.editState((s) => {
      (s.prs[0] as { automerge: boolean }).automerge = true;
    });
    // X: the fork plus anything; Y: one parent X, X's tree, the trailer and the bot's identity.
    git(r.work, ["fetch", "-q", "origin"]);
    git(r.work, ["checkout", "-q", "-B", "forge", "origin/patched"]);
    const x = commit(r.work, "src/evil.txt", "evil\n", "anything");
    const tree = git(r.work, ["rev-parse", `${x}^{tree}`]);
    const y = git(r.work, ["commit-tree", tree, "-p", x, "-m", `merge\n\nFork-Kit-Upstream: ${x}`], {
      env: { GIT_COMMITTER_EMAIL: BOT_EMAIL, GIT_AUTHOR_EMAIL: BOT_EMAIL },
    });
    git(r.work, ["push", "-q", "--force", "origin", `${y}:refs/heads/fork-kit/sync`]);
    const [res] = r.cli(["guard"]);
    expect(res.outcome).toBe("hands-off");
    expect(r.state().prs[0]?.automerge).toBe(false);
  });

  test("a push by anyone but the PR's author is someone else's, without consulting upstream", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    const path = join(r.tmp, "push-event.json");
    writeFileSync(
      path,
      JSON.stringify({
        action: "synchronize",
        sender: { login: "mallory" },
        pull_request: {
          number: 1,
          user: { login: "fork-kit-app[bot]" },
          head: { ref: "fork-kit/sync", sha: r.syncSha() },
          base: { ref: "patched" },
          labels: [],
          auto_merge: { merge_method: "merge" },
        },
      }),
    );
    // An unreachable upstream must not matter for this.
    const manifest = join(r.work, ".fork-kit.toml");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(r.upstream, join(r.tmp, "gone")));
    const [res] = r.cli(["guard"], { env: { GITHUB_EVENT_PATH: path } });
    expect(res.outcome).toBe("hands-off");
    expect(r.state().prs[0]?.automerge).toBe(false);
    expect(r.state().prs[0]?.labels).toContain(LABEL_OWNER);
  });

  test("the guard fails closed when it cannot plan", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    expect(r.state().prs[0]?.automerge).toBe(true);
    const manifest = join(r.work, ".fork-kit.toml");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(r.upstream, join(r.tmp, "gone")));
    const [, proc] = r.cli(["guard"]);
    expect(proc.status).toBe(2);
    expect(r.state().prs[0]?.automerge).toBe(false);
  });

  test("a failure to turn auto-merge off fails the run", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    git(r.work, ["fetch", "-q", "origin"]);
    git(r.work, ["checkout", "-q", "-B", "fork-kit/sync", "origin/fork-kit/sync"]);
    commit(r.work, "src/human.txt", "human\n", "human");
    git(r.work, ["push", "-q", "origin", "HEAD:refs/heads/fork-kit/sync"]);
    r.editState((s) => {
      (s as { failAutomerge?: boolean }).failAutomerge = true;
    });
    const [, proc] = r.cli(["guard"]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain("could not turn auto-merge off");
  });

  test("auto-merge names the commit fork-kit checked; a PR that can already merge is merged", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    const calls = r.state().calls as { call: string; enable?: boolean; headSha?: string }[];
    expect(calls.find((c) => c.call === "automerge" && c.enable)?.headSha).toBe(r.syncSha());

    r.editState((s) => {
      Object.assign(s.prs[0] as object, { automerge: false, clean: true });
    });
    const [res] = r.cli(["sync"]);
    expect(res.notes.some((n: string) => n.startsWith("merged #1"))).toBe(true);
    expect(r.state().prs[0]?.state).toBe("merged");
  });

  test("an open sync PR is closed once upstream is merged some other way", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    git(r.work, ["fetch", "-q", "upstream"]);
    git(r.work, ["checkout", "-q", "patched"]);
    git(r.work, ["merge", "-q", "--no-edit", "upstream/main"]);
    git(r.work, ["push", "-q", "origin", "patched"]);
    const [res] = r.cli(["sync"]);
    expect(res.outcome).toBe("up-to-date");
    expect(r.state().prs[0]?.state).toBe("closed");
  });

  test("an upstream that does not contain the one merged last is held", () => {
    const first = commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    r.cli(["sync"]);
    git(r.work, ["fetch", "-q", "origin"]);
    git(r.work, ["checkout", "-q", "patched"]);
    git(r.work, ["reset", "-q", "--hard", "origin/patched"]);
    git(r.work, ["merge", "-q", "--no-ff", "--no-edit", "origin/fork-kit/sync"]);
    git(r.work, ["push", "-q", "origin", "patched"]);
    r.editState((s) => {
      (s.prs[0] as { state: string }).state = "merged";
    });
    // Upstream main is force-moved to a line without `first`.
    git(r.upstream, ["reset", "-q", "--hard", `${first}~1`]);
    commit(r.upstream, "src/other.txt", "other\n", "upstream: other line");
    const [res] = r.cli(["sync"]);
    expect(res.outcome).toBe("diverged");
    expect(res.automerge).toBe(false);
    expect(r.state().prs).toHaveLength(1);
  });

  test("a conflict also holds for workflows the fork changed", () => {
    git(r.work, ["checkout", "-q", "patched"]);
    commit(r.upstream, ".github/workflows/ci.yml", "on: push\n", "upstream: ci");
    git(r.work, ["fetch", "-q", "upstream"]);
    git(r.work, ["merge", "-q", "--no-edit", "upstream/main"]);
    commit(r.work, ".github/workflows/ci.yml", "on: pull_request\n", "fork: harden ci");
    git(r.work, ["push", "-q", "origin", "patched"]);
    commit(r.upstream, "src/hello.txt", "hi\nworld\n", "upstream: hi");
    const [res] = r.cli(["sync"]);
    expect(res.outcome).toBe("workflow-review");
    expect(res.workflow_changes).toEqual([".github/workflows/ci.yml"]);
  });

  test("resolve keeps local commits that are not on origin", () => {
    commit(r.upstream, "src/hello.txt", "hi\nworld\n", "upstream: hi");
    r.cli(["sync"]);
    r.cli(["resolve"]);
    writeFileSync(join(r.work, "src/hello.txt"), "hallo hi\nworld\n");
    git(r.work, ["commit", "-qam", "half done"]);
    const local = git(r.work, ["rev-parse", "HEAD"]);
    const [, proc] = r.cli(["resolve"]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain("not on origin's");
    expect(git(r.work, ["rev-parse", "fork-kit/sync"])).toBe(local);
  });

  test("a dry run pushes nothing", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    const [res] = r.cli(["sync", "--dry-run"]);
    expect(res.outcome).toBe("clean");
    expect(res.automerge).toBe(true);
    expect(r.syncSha()).toBe("");
    expect(r.state().prs).toEqual([]);
  });

  test("the lease refuses to overwrite a concurrent push", () => {
    commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
    // A hook-free way to race: make origin's sync branch appear after fork-kit's fetch, via a wrapper
    // that pushes it just before fork-kit's own push.
    const wrapper = join(r.tmp, "git-wrapper.sh");
    const realGit = run(r.tmp, ["sh", "-c", "command -v git"]).stdout.trim();
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = push ] && [ ! -f "${r.tmp}/raced" ]; then touch "${r.tmp}/raced"; "${realGit}" push -q origin patched:refs/heads/fork-kit/sync; fi\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const bin = join(r.tmp, "bin");
    run(r.tmp, ["mkdir", "-p", bin]);
    run(r.tmp, ["ln", "-s", wrapper, join(bin, "git")]);
    const [, proc] = r.cli(["sync"], { env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain("stale info");
    expect(r.syncSha()).toBe(r.sha("refs/heads/patched"));
  });

  test("resolve leaves conflicts for a human", () => {
    commit(r.upstream, "src/hello.txt", "hi\nworld\n", "upstream: hi");
    r.cli(["sync"]);
    const [res, proc] = r.cli(["resolve"]);
    expect(proc.status).toBe(1);
    expect(res.conflicts).toEqual([{ path: "src/hello.txt", patches: ["greeting"] }]);
    expect(proc.stdout).toContain("patch greeting: Greet in German");
    expect(git(r.work, ["branch", "--show-current"])).toBe("fork-kit/sync");
    // The push it suggests works, and the branch name is not shadowed by fork-kit's own refs.
    expect(res.notes.at(-1)).toContain("git push origin HEAD:refs/heads/fork-kit/sync");
    writeFileSync(join(r.work, "src/hello.txt"), "hallo hi\nworld\n");
    git(r.work, ["commit", "-qam", "resolve"]);
    git(r.work, ["push", "-q", "origin", "fork-kit/sync"]);
    expect(r.syncSha()).toBe(git(r.work, ["rev-parse", "HEAD"]));
  });

  test("unrelated histories explain themselves", () => {
    const other = join(r.tmp, "other");
    git(r.tmp, ["init", "-q", "-b", "main", other]);
    commit(other, "x", "x\n", "unrelated");
    const manifest = join(r.work, ".fork-kit.toml");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace(r.upstream, other));
    const [, proc] = r.cli(["sync"]);
    expect(proc.status).toBe(2);
    expect(proc.stderr).toContain("share no history");
  });

  test("a shallow clone is refused", () => {
    const shallow = join(r.tmp, "shallow");
    git(r.tmp, ["clone", "-q", "--depth", "1", "-b", "patched", `file://${r.origin}`, shallow]);
    const p = run(shallow, ["bun", join(ROOT, "src/bin.ts"), "status"], {
      check: false,
      env: { FORK_KIT_FORGE: `fake:${r.forge}` },
    });
    expect(p.status).toBe(2);
    expect(p.stderr).toContain("shallow clone");
  });

  test("the Node bundle behaves like the source", () => {
    commit(r.upstream, "src/hello.txt", "hi\nworld\n", "upstream: hi");
    const [res, proc] = r.cli(["sync"], { runtime: ["node", join(ROOT, "dist/cli.js")] });
    expect(proc.stderr).toBe("");
    expect(res.outcome).toBe("conflict");
    expect(res.conflicts).toEqual([{ path: "src/hello.txt", patches: ["greeting"] }]);
    expect(r.state().prs[0]?.labels).toEqual([LABEL_CONFLICT]);
  });
});

describe("action entry", () => {
  test("maps inputs to the CLI and writes outputs, under Node", () => {
    const r = new Repos();
    try {
      commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
      const out = join(r.tmp, "github_output");
      writeFileSync(out, "");
      const p = run(r.work, ["node", join(ROOT, "dist/action.js")], {
        check: false,
        env: {
          FORK_KIT_FORGE: `fake:${r.forge}`,
          GITHUB_OUTPUT: out,
          GITHUB_STEP_SUMMARY: "",
          INPUT_COMMAND: "sync",
          INPUT_TOKEN: "secret-token",
          "INPUT_DRY-RUN": "true",
          INPUT_MANIFEST: ".fork-kit.toml",
          INPUT_REPORT: "result.json",
        },
      });
      expect(p.status).toBe(0);
      expect(p.stdout).toContain("::add-mask::secret-token");
      const outputs = readFileSync(out, "utf8");
      expect(outputs).toContain("outcome=clean");
      expect(outputs).toContain("automerge=true");
      expect(outputs).toContain("report=result.json");
      expect(JSON.parse(readFileSync(join(r.work, "result.json"), "utf8")).outcome).toBe("clean");
      expect(r.syncSha()).toBe(""); // dry run
    } finally {
      r.cleanup();
    }
  });

  test("central mode: working-directory, with the report relative to the workspace", () => {
    const r = new Repos();
    try {
      commit(r.upstream, "src/new.txt", "new\n", "upstream: new");
      const out = join(r.tmp, "github_output");
      writeFileSync(out, "");
      const p = run(r.tmp, ["node", join(ROOT, "dist/action.js")], {
        check: false,
        env: {
          FORK_KIT_FORGE: `fake:${r.forge}`,
          GITHUB_OUTPUT: out,
          GITHUB_STEP_SUMMARY: "",
          INPUT_COMMAND: "sync",
          INPUT_TOKEN: "secret-token",
          "INPUT_DRY-RUN": "true",
          INPUT_REPOSITORY: "o/fork",
          "INPUT_WORKING-DIRECTORY": "work",
          INPUT_WORKFLOW: ".github/workflows/fork-kit.yml",
          INPUT_REPORT: "result.json",
        },
      });
      expect(p.status).toBe(0);
      expect(readFileSync(out, "utf8")).toContain(`report=${join(realpathSync(r.tmp), "result.json")}`);
      expect(JSON.parse(readFileSync(join(r.tmp, "result.json"), "utf8")).outcome).toBe("clean");
    } finally {
      r.cleanup();
    }
  });

  test("rejects unknown commands", () => {
    const p = run(ROOT, ["node", join(ROOT, "dist/action.js")], {
      check: false,
      env: { INPUT_COMMAND: "resolve", INPUT_TOKEN: "t" },
    });
    expect(p.status).toBe(2);
    expect(p.stdout).toContain("unknown command resolve");
  });
});

describe("tracking", () => {
  test("tag tracking picks the highest version", () => {
    const r = new Repos("tag:v\\\\d+\\\\.\\\\d+");
    try {
      for (const tag of ["v1.2", "v1.10", "v1.9", "nightly"]) {
        commit(r.upstream, `src/${tag}.txt`, tag, `upstream: ${tag}`);
        git(r.upstream, ["tag", tag]);
      }
      const [res] = r.cli(["status"]);
      expect(res.upstream.ref).toBe("v1.10");
      expect(res.upstream.sha).toBe(git(r.upstream, ["rev-parse", "v1.10^{commit}"]));
    } finally {
      r.cleanup();
    }
  });

  test("release tracking asks the forge and rejects odd names", () => {
    const r = new Repos();
    try {
      const ghUrl = "https://github.com/example/upstream";
      const manifest = join(r.work, ".fork-kit.toml");
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8")
          .replace(`url = "${r.upstream}"`, `url = "${ghUrl}"`)
          .replace('track = "branch:main"', 'track = "release"'),
      );
      git(r.work, ["config", `url.${r.upstream}.insteadOf`, ghUrl]);
      commit(r.upstream, "src/r.txt", "r\n", "upstream: release");
      git(r.upstream, ["tag", "v2.0.0"]);
      writeFileSync(r.forge, JSON.stringify({ prs: [], calls: [], releases: { [ghUrl]: "v2.0.0" } }));
      expect(r.cli(["status"])[0].upstream.ref).toBe("v2.0.0");
      writeFileSync(r.forge, JSON.stringify({ prs: [], calls: [], releases: { [ghUrl]: "v2<!--" } }));
      const [, proc] = r.cli(["status"]);
      expect(proc.status).toBe(2);
      expect(proc.stderr).toContain("characters fork-kit does not accept");
    } finally {
      r.cleanup();
    }
  });
});

describe("ledger", () => {
  test("reports uncovered files and stale patches", () => {
    const r = new Repos();
    try {
      const manifest = join(r.work, ".fork-kit.toml");
      writeFileSync(manifest, `${readFileSync(manifest, "utf8")}\n[[patch]]\nid = "gone"\npaths = ["src/gone.txt"]\n`);
      git(r.work, ["commit", "-qam", "fork: ledger entry"]);
      r.pushFork("src/untracked.txt", "x\n", "fork: undocumented change");
      const [res, proc] = r.cli(["ledger", "--strict"]);
      expect(proc.status).toBe(1);
      expect(res.ledger.uncovered).toEqual(["src/untracked.txt"]);
      expect(res.ledger.stale).toEqual(["gone"]);
    } finally {
      r.cleanup();
    }
  });

  test("a manifest outside the repository root is not counted as a change", () => {
    const r = new Repos();
    try {
      git(r.work, ["mv", ".fork-kit.toml", "ci.fork-kit.toml"]);
      run(r.work, ["mkdir", "ci"]);
      git(r.work, ["mv", "ci.fork-kit.toml", "ci/.fork-kit.toml"]);
      git(r.work, ["commit", "-qm", "fork: move the manifest"]);
      git(r.work, ["push", "-q", "origin", "patched"]);
      const [res, proc] = r.cli(["--manifest", "ci/.fork-kit.toml", "ledger", "--strict"]);
      expect(res.ledger.uncovered).toEqual([]);
      expect(proc.status).toBe(0);
    } finally {
      r.cleanup();
    }
  });
});

describe("workflow_changes = push", () => {
  test("upstream workflow changes neither hold the push nor block auto-merge", () => {
    const r = new Repos("branch:main", 'workflow_changes = "push"');
    try {
      commit(r.upstream, ".github/workflows/ci.yml", "on: push\n", "upstream: ci");
      const [res] = r.cli(["sync"]);
      expect(res.outcome).toBe("clean");
      expect(res.automerge).toBe(true);
      expect(r.state().prs[0]?.labels).toEqual([LABEL_WORKFLOWS]);
    } finally {
      r.cleanup();
    }
  });
});
