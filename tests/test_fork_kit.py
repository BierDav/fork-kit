# Copyright 2026 The fork-kit authors
# SPDX-License-Identifier: Apache-2.0
"""End-to-end tests against throwaway repositories and a fake forge."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import fork_kit

ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
}
BOT = fork_kit.identity()


def run(cwd, *args, check=True, env=None):
    proc = subprocess.run(args, check=False, cwd=cwd, capture_output=True, text=True, env={**os.environ, **ENV, **(env or {})})
    if check and proc.returncode != 0:
        raise AssertionError(f"{args} failed:\n{proc.stdout}\n{proc.stderr}")
    return proc


def git(cwd, *args, check=True, env=None):
    return run(cwd, "git", *args, check=check, env=env).stdout.strip()


def commit(repo, path, content, msg):
    p = Path(repo, path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    git(repo, "add", path)
    git(repo, "commit", "-q", "-m", msg)
    return git(repo, "rev-parse", "HEAD")


MANIFEST = """
[upstream]
url = "{url}"
track = "{track}"

[fork]
branch = "patched"
{fork_extra}

[ledger]
ignore = [".github/workflows/fork-kit.yml"]

[[patch]]
id = "greeting"
summary = "Greet in German"
paths = ["src/hello.txt"]
tests = ["test_greeting"]

[[patch]]
id = "extra"
summary = "An extra feature"
paths = ["src/extra/**"]
"""


class Repos:
    """upstream (a working repo used as the upstream url), origin (bare fork), work (clone of origin)."""

    def __init__(self, track="branch:main", fork_extra=""):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.upstream, self.origin, self.work = t / "upstream", t / "origin.git", t / "work"
        self.forge = t / "forge.json"
        git(t, "init", "-q", "-b", "main", str(self.upstream))
        commit(self.upstream, "src/hello.txt", "hello\nworld\n", "upstream: init")
        commit(self.upstream, "README", "upstream\n", "upstream: readme")
        git(t, "init", "-q", "--bare", "-b", "patched", str(self.origin))
        git(t, "clone", "-q", str(self.upstream), str(self.work))
        git(self.work, "remote", "rename", "origin", "upstream")
        git(self.work, "remote", "add", "origin", str(self.origin))
        git(self.work, "checkout", "-q", "-b", "patched")
        commit(self.work, "src/hello.txt", "hallo\nworld\n", "fork: greet in German")
        commit(self.work, "src/extra/feature.txt", "feature\n", "fork: extra")
        Path(self.work, ".fork-kit.toml").write_text(MANIFEST.format(url=self.upstream, track=track, fork_extra=fork_extra))
        git(self.work, "add", ".fork-kit.toml")
        git(self.work, "commit", "-q", "-m", "fork: manifest")
        git(self.work, "push", "-q", "origin", "patched")
        self.forge.write_text(json.dumps({"prs": [], "calls": []}))

    def cli(self, *args, env=None):
        proc = subprocess.run(
            [sys.executable, str(ROOT / "fork_kit.py"), "--json", *args],
            check=False,
            cwd=self.work,
            capture_output=True,
            text=True,
            env={**os.environ, **ENV, "FORK_KIT_FORGE": f"fake:{self.forge}", **(env or {})},
        )
        out = proc.stdout
        start = out.find("{\n")
        return (json.loads(out[start:]) if start >= 0 else None), proc

    def state(self):
        return json.loads(self.forge.read_text())

    def edit_state(self, fn):
        st = self.state()
        fn(st)
        self.forge.write_text(json.dumps(st))

    def sha(self, ref):
        return git(self.origin, "rev-parse", "--verify", "-q", ref, check=False)

    def sync_sha(self):
        return self.sha("refs/heads/fork-kit/sync")

    def push_fork(self, path, content, msg):
        git(self.work, "checkout", "-q", "patched")
        git(self.work, "pull", "-q", "--ff-only", "origin", "patched")
        sha = commit(self.work, path, content, msg)
        git(self.work, "push", "-q", "origin", "patched")
        return sha


class SyncTests(unittest.TestCase):
    def setUp(self):
        self.r = Repos()

    def tearDown(self):
        self.r.tmp.cleanup()

    def test_up_to_date_does_nothing(self):
        git(self.r.work, "fetch", "-q", "upstream")
        git(self.r.work, "merge", "-q", "--no-edit", "upstream/main")
        git(self.r.work, "push", "-q", "origin", "patched")
        res, _ = self.r.cli("sync")
        self.assertEqual(res["outcome"], "up-to-date")
        self.assertEqual(self.r.state()["prs"], [])
        self.assertEqual(self.r.sync_sha(), "")

    def test_clean_merge_opens_pr_with_automerge(self):
        up = commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new file")
        res, _ = self.r.cli("sync")
        self.assertEqual(res["outcome"], "clean")
        sync = self.r.sync_sha()
        self.assertEqual(fork_kit_parents(self.r.origin, sync), [self.r.sha("refs/heads/patched"), up])
        self.assertIn(f"Fork-Kit-Upstream: {up}", git(self.r.origin, "log", "-1", "--format=%B", sync))
        self.assertEqual(git(self.r.origin, "log", "-1", "--format=%ce", sync), BOT["GIT_COMMITTER_EMAIL"])
        self.assertEqual(git(self.r.origin, "show", f"{sync}:src/hello.txt"), "hallo\nworld")
        self.assertEqual(git(self.r.origin, "show", f"{sync}:src/new.txt"), "new")
        (pr,) = self.r.state()["prs"]
        self.assertTrue(pr["automerge"])
        self.assertEqual(pr["labels"], [])
        self.assertIn("1 new upstream commit", pr["body"])

        res2, _ = self.r.cli("sync")
        self.assertEqual(self.r.sync_sha(), sync)
        self.assertEqual(len(self.r.state()["prs"]), 1)
        self.assertTrue(res2["automerge"])

    def test_conflict_maps_files_to_patches(self):
        up = commit(self.r.upstream, "src/hello.txt", "hi\nworld\n", "upstream: hi")
        res, _ = self.r.cli("sync")
        self.assertEqual(res["outcome"], "conflict")
        self.assertEqual(res["conflicts"], [{"path": "src/hello.txt", "patches": ["greeting"]}])
        sync = self.r.sync_sha()
        self.assertEqual(fork_kit_parents(self.r.origin, sync), [up])
        (pr,) = self.r.state()["prs"]
        self.assertEqual(pr["labels"], [fork_kit.LABEL_CONFLICT])
        self.assertFalse(pr["automerge"])
        self.assertIn(r"| src/hello\.txt | greeting |", pr["body"])

        # Upstream reverts its change: the conflict is gone and so is the label.
        commit(self.r.upstream, "src/hello.txt", "hello\nworld\n", "upstream: revert")
        res, _ = self.r.cli("sync")
        self.assertEqual(res["outcome"], "clean")
        (pr,) = self.r.state()["prs"]
        self.assertEqual(pr["labels"], [])
        self.assertTrue(pr["automerge"])

    def test_unicode_paths_are_reported_verbatim(self):
        name = "src/extra/grüße file.txt"
        commit(self.r.upstream, name, "a\n", "upstream: unicode")
        self.r.push_fork(name, "b\n", "fork: unicode")
        res, _ = self.r.cli("sync")
        self.assertEqual(res["conflicts"], [{"path": name, "patches": ["extra"]}])

    def test_workflow_changes_are_held_by_default(self):
        commit(self.r.upstream, ".github/workflows/ci.yml", "on: push\n", "upstream: ci")
        res, _ = self.r.cli("sync")
        self.assertEqual(res["outcome"], "workflow-review")
        self.assertEqual(res["workflow_changes"], [".github/workflows/ci.yml"])
        self.assertEqual(self.r.sync_sha(), "")
        self.assertEqual(self.r.state()["prs"], [])

        res, _ = self.r.cli("sync", "--allow-workflow-changes")
        self.assertEqual(res["outcome"], "clean")
        self.assertNotEqual(self.r.sync_sha(), "")
        (pr,) = self.r.state()["prs"]
        self.assertFalse(pr["automerge"])
        self.assertEqual(pr["labels"], [fork_kit.LABEL_WORKFLOWS])

    def test_failing_or_unreadable_checks_block_automerge(self):
        commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        fork = self.r.sha("refs/heads/patched")
        for state, reason in (("failure", "is failing its checks"), ("error", "could not read the checks")):
            self.r.edit_state(lambda st, s=state: st.update(checks={fork: s}))
            res, _ = self.r.cli("sync", "--dry-run")
            self.assertFalse(res["automerge"])
            self.assertTrue(any(reason in w for w in res["automerge_blocked_by"]), res["automerge_blocked_by"])

    def test_hold_label_keeps_automerge_off(self):
        commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        self.r.cli("sync")
        self.r.edit_state(lambda st: st["prs"][0].update(labels=[fork_kit.LABEL_HOLD], automerge=False))
        commit(self.r.upstream, "src/new2.txt", "new\n", "upstream: new2")
        res, _ = self.r.cli("sync")
        self.assertFalse(res["automerge"])
        self.assertFalse(self.r.state()["prs"][0]["automerge"])
        self.assertIn(fork_kit.LABEL_HOLD, self.r.state()["prs"][0]["labels"])

    def test_fork_moving_rebuilds_the_merge(self):
        up = commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        self.r.cli("sync")
        first = self.r.sync_sha()
        fork2 = self.r.push_fork("src/extra/more.txt", "more\n", "fork: more")
        self.r.cli("sync")
        second = self.r.sync_sha()
        self.assertNotEqual(first, second)
        self.assertEqual(fork_kit_parents(self.r.origin, second), [fork2, up])

    def test_force_moved_fork_branch_rebuilds_instead_of_hands_off(self):
        up = commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        self.r.cli("sync")
        git(self.r.work, "checkout", "-q", "patched")
        git(self.r.work, "commit", "-q", "--amend", "-m", "fork: manifest (reworded)")
        git(self.r.work, "push", "-q", "--force", "origin", "patched")
        rewritten = self.r.sha("refs/heads/patched")
        res, _ = self.r.cli("sync")
        self.assertEqual(res["outcome"], "clean")
        self.assertEqual(fork_kit_parents(self.r.origin, self.r.sync_sha()), [rewritten, up])
        self.assertNotIn(fork_kit.LABEL_OWNER, self.r.state()["prs"][0]["labels"])

    def test_hand_edited_branch_is_left_alone(self):
        commit(self.r.upstream, "src/hello.txt", "hi\nworld\n", "upstream: hi")
        self.r.cli("sync")
        git(self.r.work, "fetch", "-q", "origin")
        git(self.r.work, "checkout", "-q", "-B", "fork-kit/sync", "origin/fork-kit/sync")
        run(self.r.work, "git", "merge", "--no-edit", "origin/patched", check=False)
        Path(self.r.work, "src/hello.txt").write_text("hallo hi\nworld\n")
        git(self.r.work, "commit", "-qam", "resolve")
        git(self.r.work, "push", "-q", "origin", "fork-kit/sync")
        human = self.r.sync_sha()
        self.r.edit_state(lambda st: st["prs"][0].update(automerge=True))

        res, _ = self.r.cli("guard")
        self.assertEqual(res["outcome"], "hands-off")
        (pr,) = self.r.state()["prs"]
        self.assertFalse(pr["automerge"])
        self.assertIn(fork_kit.LABEL_OWNER, pr["labels"])

        commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        self.r.cli("sync")
        self.r.cli("sync")
        self.assertEqual(self.r.sync_sha(), human)
        self.assertEqual(len(self.r.state()["prs"][0]["comments"]), 1)

        self.r.edit_state(lambda st: st["prs"][0].update(state="closed"))
        res, _ = self.r.cli("sync")
        self.assertEqual(res["outcome"], "conflict")
        self.assertNotEqual(self.r.sync_sha(), human)
        self.assertEqual(len(self.r.state()["prs"]), 2)

    def test_amended_bot_commit_counts_as_someone_elses(self):
        commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        self.r.cli("sync")
        git(self.r.work, "fetch", "-q", "origin")
        git(self.r.work, "checkout", "-q", "-B", "fork-kit/sync", "origin/fork-kit/sync")
        Path(self.r.work, "src/new.txt").write_text("changed by hand\n")
        git(self.r.work, "add", "src/new.txt")
        # Even with the bot's identity and trailer kept, the tree gives it away.
        git(self.r.work, "commit", "-q", "--amend", "--no-edit", env={"GIT_COMMITTER_EMAIL": BOT["GIT_COMMITTER_EMAIL"]})
        git(self.r.work, "push", "-q", "--force", "origin", "fork-kit/sync")
        amended = self.r.sync_sha()
        res, _ = self.r.cli("guard")
        self.assertEqual(res["outcome"], "hands-off")
        self.r.push_fork("src/extra/more.txt", "more\n", "fork: more")
        self.r.cli("sync")
        self.assertEqual(self.r.sync_sha(), amended)

    def test_merged_sync_pr_then_next_upstream(self):
        commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        self.r.cli("sync")
        # The PR merges (a merge commit on the fork branch).
        git(self.r.work, "fetch", "-q", "origin")
        git(self.r.work, "checkout", "-q", "patched")
        git(self.r.work, "reset", "-q", "--hard", "origin/patched")
        git(self.r.work, "merge", "-q", "--no-ff", "--no-edit", "origin/fork-kit/sync")
        git(self.r.work, "push", "-q", "origin", "patched")
        self.r.edit_state(lambda st: st["prs"][0].update(state="merged"))
        res, _ = self.r.cli("sync")
        self.assertEqual(res["outcome"], "up-to-date")
        up2 = commit(self.r.upstream, "src/new2.txt", "new\n", "upstream: new2")
        res, _ = self.r.cli("sync")
        self.assertEqual(res["outcome"], "clean")
        self.assertEqual(res["notes"][-1][:6], "pushed")
        self.assertEqual(fork_kit_parents(self.r.origin, self.r.sync_sha())[1], up2)

    def test_guard_accepts_fork_kits_own_branch_and_ignores_other_prs(self):
        commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        self.r.cli("sync")
        res, _ = self.r.cli("guard")
        self.assertNotEqual(res["outcome"], "hands-off")
        self.assertTrue(self.r.state()["prs"][0]["automerge"])
        res, _ = self.r.cli("guard", env={"GITHUB_HEAD_REF": "feature"})
        self.assertEqual(res["outcome"], "not-sync-pr")

    def test_dry_run_pushes_nothing(self):
        commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        res, _ = self.r.cli("sync", "--dry-run")
        self.assertEqual(res["outcome"], "clean")
        self.assertTrue(res["automerge"])
        self.assertEqual(self.r.sync_sha(), "")
        self.assertEqual(self.r.state()["prs"], [])

    def test_lease_refuses_to_overwrite_a_concurrent_push(self):
        commit(self.r.upstream, "src/new.txt", "new\n", "upstream: new")
        cwd = os.getcwd()
        os.chdir(self.r.work)
        old_env = dict(os.environ)
        os.environ.update(ENV)
        os.environ["FORK_KIT_FORGE"] = f"fake:{self.r.forge}"
        try:
            m = fork_kit.load_manifest(".fork-kit.toml")
            forge = fork_kit.make_forge()
            stale = fork_kit.plan(m, forge)
            git(self.r.work, "push", "-q", "origin", "patched:refs/heads/fork-kit/sync")
            real_plan = fork_kit.plan
            fork_kit.plan = lambda *_: stale
            try:
                args = type("A", (), {"dry_run": False, "allow_workflow_changes": False})()
                with self.assertRaises(fork_kit.Failure):
                    fork_kit.cmd_sync(args, m, forge)
            finally:
                fork_kit.plan = real_plan
        finally:
            os.chdir(cwd)
            os.environ.clear()
            os.environ.update(old_env)
        self.assertEqual(self.r.sync_sha(), self.r.sha("refs/heads/patched"))

    def test_resolve_leaves_conflicts_for_a_human(self):
        commit(self.r.upstream, "src/hello.txt", "hi\nworld\n", "upstream: hi")
        self.r.cli("sync")
        res, proc = self.r.cli("resolve")
        self.assertEqual(proc.returncode, 1)
        self.assertEqual(res["conflicts"], [{"path": "src/hello.txt", "patches": ["greeting"]}])
        self.assertIn("patch greeting: Greet in German", proc.stdout)
        self.assertEqual(git(self.r.work, "branch", "--show-current"), "fork-kit/sync")

    def test_unrelated_histories_explain_themselves(self):
        other = Path(self.r.tmp.name, "other")
        git(self.r.tmp.name, "init", "-q", "-b", "main", str(other))
        commit(other, "x", "x\n", "unrelated")
        manifest = Path(self.r.work, ".fork-kit.toml")
        manifest.write_text(manifest.read_text().replace(str(self.r.upstream), str(other)))
        _, proc = self.r.cli("sync")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("share no history", proc.stderr)

    def test_shallow_clone_is_refused(self):
        shallow = Path(self.r.tmp.name, "shallow")
        git(self.r.tmp.name, "clone", "-q", "--depth", "1", f"file://{self.r.origin}", str(shallow), "-b", "patched")
        proc = run(
            shallow,
            sys.executable,
            str(ROOT / "fork_kit.py"),
            "status",
            check=False,
            env={"FORK_KIT_FORGE": f"fake:{self.r.forge}"},
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("shallow clone", proc.stderr)


def fork_kit_parents(repo, sha):
    return git(repo, "rev-list", "--parents", "-n1", sha).split()[1:]


class TrackingTests(unittest.TestCase):
    def test_tag_tracking_picks_the_highest_version(self):
        r = Repos(track=r"tag:v\\d+\\.\\d+")
        try:
            for tag in ("v1.2", "v1.10", "v1.9", "nightly"):
                commit(r.upstream, f"src/{tag}.txt", tag, f"upstream: {tag}")
                git(r.upstream, "tag", tag)
            res, _ = r.cli("status")
            self.assertEqual(res["upstream"]["ref"], "v1.10")
            self.assertEqual(res["upstream"]["sha"], git(r.upstream, "rev-parse", "v1.10^{commit}"))
        finally:
            r.tmp.cleanup()

    def test_release_tracking_asks_the_forge_and_rejects_odd_names(self):
        r = Repos()
        try:
            gh_url = "https://github.com/example/upstream"
            manifest = Path(r.work, ".fork-kit.toml")
            text = manifest.read_text().replace(f'url = "{r.upstream}"', f'url = "{gh_url}"')
            manifest.write_text(text.replace('track = "branch:main"', 'track = "release"'))
            git(r.work, "config", f"url.{r.upstream}.insteadOf", gh_url)
            commit(r.upstream, "src/r.txt", "r\n", "upstream: release")
            git(r.upstream, "tag", "v2.0.0")
            r.forge.write_text(json.dumps({"prs": [], "calls": [], "releases": {gh_url: "v2.0.0"}}))
            res, _ = r.cli("status")
            self.assertEqual(res["upstream"]["ref"], "v2.0.0")
            r.forge.write_text(json.dumps({"prs": [], "calls": [], "releases": {gh_url: "v2<!--"}}))
            _, proc = r.cli("status")
            self.assertEqual(proc.returncode, 2)
            self.assertIn("characters fork-kit does not accept", proc.stderr)
        finally:
            r.tmp.cleanup()


class LedgerTests(unittest.TestCase):
    def test_uncovered_and_stale(self):
        r = Repos()
        try:
            manifest = Path(r.work, ".fork-kit.toml")
            manifest.write_text(manifest.read_text() + '\n[[patch]]\nid = "gone"\npaths = ["src/gone.txt"]\n')
            git(r.work, "commit", "-qam", "fork: ledger entry")
            r.push_fork("src/untracked.txt", "x\n", "fork: undocumented change")
            res, proc = r.cli("ledger", "--strict")
            self.assertEqual(proc.returncode, 1)
            self.assertEqual(res["ledger"]["uncovered"], ["src/untracked.txt"])
            self.assertEqual(res["ledger"]["stale"], ["gone"])
        finally:
            r.tmp.cleanup()


class GitHubTests(unittest.TestCase):
    """The GitHub forge against a stub `gh` that answers from a table."""

    STUB = textwrap.dedent("""\
        #!/usr/bin/env python3
        import json, os, sys
        args = " ".join(sys.argv[1:])
        with open(os.environ["GH_STUB_LOG"], "a") as f:
            f.write(args + "\\n")
        for needle, out, code in json.load(open(os.environ["GH_STUB_TABLE"])):
            if needle in args:
                sys.stdout.write(out)
                sys.exit(code)
        sys.stderr.write("no stub for " + args)
        sys.exit(1)
    """)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        gh = t / "gh"
        gh.write_text(self.STUB)
        gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
        self.table, self.log = t / "table.json", t / "log"
        self.old = dict(os.environ)
        os.environ.update(PATH=f"{t}:{os.environ['PATH']}", GH_STUB_TABLE=str(self.table), GH_STUB_LOG=str(self.log))
        os.environ["GITHUB_WORKFLOW_REF"] = "o/r/.github/workflows/fork-kit.yml@refs/heads/main"

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old)
        self.tmp.cleanup()

    def stub(self, rows):
        self.table.write_text(json.dumps(rows))

    def test_checks_combine_runs_and_statuses_and_skip_own_runs(self):
        own = json.dumps({"id": 7, "path": ".github/workflows/fork-kit.yml"})
        other = json.dumps({"id": 8, "path": ".github/workflows/ci.yml"})
        failed_own = json.dumps({"status": "completed", "conclusion": "failure", "details_url": "https://x/actions/runs/7/job/1"})
        ok = json.dumps({"status": "completed", "conclusion": "success", "details_url": "https://x/actions/runs/8/job/2"})
        self.stub(
            [
                ["actions/runs", f"{own}\n{other}\n", 0],
                ["check-runs", f"{failed_own}\n{ok}\n", 0],
                ["/status", json.dumps({"statuses": [{"state": "success"}]}), 0],
            ]
        )
        self.assertEqual(fork_kit.GitHub("o/r").checks("abc"), "success")
        self.stub(
            [
                ["actions/runs", "", 0],
                ["check-runs", f"{ok}\n", 0],
                ["/status", json.dumps({"statuses": [{"state": "failure"}]}), 0],
            ]
        )
        self.assertEqual(fork_kit.GitHub("o/r").checks("abc"), "failure")
        self.assertIn("--paginate", self.log.read_text())

    def test_checks_error_is_reported(self):
        self.stub([["actions/runs", "", 0], ["check-runs", "", 1]])
        self.assertEqual(fork_kit.GitHub("o/r").checks("abc"), "error")

    def test_automerge_failure_is_returned(self):
        self.stub([["pr merge", "", 1]])
        self.assertTrue(fork_kit.GitHub("o/r").automerge(3, True))


class UnitTests(unittest.TestCase):
    def test_glob(self):
        g = fork_kit.glob_match
        self.assertTrue(g("src/**", "src/a/b.rs"))
        self.assertTrue(g("**/*.rs", "a.rs"))
        self.assertTrue(g("**/*.rs", "x/y/a.rs"))
        self.assertTrue(g("src/*.rs", "src/a.rs"))
        self.assertFalse(g("src/*.rs", "src/x/a.rs"))
        self.assertFalse(g("src/a.rs", "src/a.rsx"))

    def test_checks_summary(self):
        s = fork_kit.summarize_checks
        self.assertEqual(s([]), "unknown")
        self.assertEqual(s([("completed", "success"), ("completed", "skipped")]), "success")
        self.assertEqual(s([("completed", "success"), ("in_progress", None)]), "pending")
        self.assertEqual(s([("in_progress", None), ("completed", "failure")]), "failure")

    def test_github_slug(self):
        self.assertEqual(fork_kit.github_slug("https://github.com/a/b.git"), "a/b")
        self.assertEqual(fork_kit.github_slug("git@github.com:a/b"), "a/b")
        self.assertIsNone(fork_kit.github_slug("https://gitlab.com/a/b"))

    def test_markdown_escaping(self):
        self.assertEqual(fork_kit.md("a|b`c\nd<!--"), r"a\|b\`c d\<\!\-\-")

    def test_manifest_errors(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t, "m.toml")
            p.write_text(
                textwrap.dedent("""
                    [upstream]
                    track = "sometimes"
                    [fork]
                    branch = "x"
                    sync_branch = "x"
                    workflow_changes = "maybe"
                    [[patch]]
                    id = "Bad Id"
                """)
            )
            with self.assertRaises(fork_kit.Failure) as cm:
                fork_kit.load_manifest(str(p))
            msg = str(cm.exception)
            for needle in (
                "url is required",
                "track must be",
                "sync_branch must differ",
                "workflow_changes must be",
                "id must match",
                "paths is required",
            ):
                self.assertIn(needle, msg)


if __name__ == "__main__":
    unittest.main()
