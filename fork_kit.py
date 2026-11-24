#!/usr/bin/env python3
# Copyright 2026 The fork-kit authors
# SPDX-License-Identifier: Apache-2.0
"""fork-kit: keep a downstream fork merged with its upstream through one sync pull request.

The sync and guard commands only run git plumbing and the forge's API. They
never build or run code from the fork or from upstream. Note that pushing the
sync branch makes GitHub run the workflows in it, upstream's included; see
"Trust model" in the README.
"""

from __future__ import annotations

import sys

if sys.version_info < (3, 11):  # noqa: UP036 - give older interpreters a clear message
    sys.exit("fork-kit needs Python >= 3.11")

import argparse
import json
import os
import re
import subprocess
import tomllib
import urllib.parse
from dataclasses import dataclass, field
from pathlib import Path

VERSION = "0.1.0"
SCHEMA = 1
MIN_GIT = (2, 38)  # git merge-tree --write-tree

TRAILER = "Fork-Kit-Upstream"
UPSTREAM_REF = "refs/fork-kit/upstream"
LABEL_CONFLICT = "fork-kit:conflict"
LABEL_WORKFLOWS = "fork-kit:workflow-change"
LABEL_OWNER = "fork-kit:needs-owner"
LABEL_HOLD = "fork-kit:hold"
LABELS = {
    LABEL_CONFLICT: ("b60205", "Merging upstream conflicts with the fork"),
    LABEL_WORKFLOWS: ("fbca04", "Upstream changed .github/; needs a human"),
    LABEL_OWNER: ("5319e7", "Someone else pushed to the sync branch; fork-kit keeps out"),
    LABEL_HOLD: ("d4c5f9", "Set by a human: fork-kit never enables auto-merge"),
}
MARKER = "<!-- fork-kit -->"
SAFE_REF = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/+-]*")


class Failure(Exception):
    """An error the user can act on; printed without a traceback."""


# --------------------------------------------------------------------------- git


def git(*args: str, check: bool = True, env: dict | None = None, input: str | None = None) -> str:
    proc = subprocess.run(
        ["git", *args],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
        input=input,
    )
    if check and proc.returncode != 0:
        raise Failure(f"git {' '.join(args)} failed:\n{proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout.strip()


def git_ok(*args: str) -> bool:
    return subprocess.run(["git", *args], check=False, capture_output=True).returncode == 0


def git_paths(*args: str) -> list[str]:
    """Run a git command with -z and return the NUL-separated paths it prints."""
    proc = subprocess.run(["git", args[0], "-z", *args[1:]], check=False, capture_output=True)
    if proc.returncode != 0:
        raise Failure(f"git {' '.join(args)} failed:\n{proc.stderr.decode(errors='replace').strip()}")
    return [p.decode(errors="surrogateescape") for p in proc.stdout.split(b"\0") if p]


def git_version() -> tuple[int, int]:
    m = re.search(r"(\d+)\.(\d+)", git("--version"))
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def rev_list(*args: str) -> list[str]:
    out = git("rev-list", *args)
    return out.split() if out else []


def parents_of(sha: str) -> list[str]:
    return git("rev-list", "--parents", "-n1", sha).split()[1:]


def trailer_value(sha: str, key: str) -> str | None:
    body = git("log", "-1", "--format=%B", sha)
    for line in reversed(body.splitlines()):
        if line.startswith(f"{key}:"):
            return line.split(":", 1)[1].strip()
    return None


def merge_tree(ours: str, theirs: str) -> tuple[str | None, list[str]]:
    """Merge in memory. Returns (tree, []) when clean, (None, conflicting paths) otherwise."""
    proc = subprocess.run(
        ["git", "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs],
        check=False,
        capture_output=True,
    )
    if proc.returncode not in (0, 1):
        err = proc.stderr.decode(errors="replace").strip()
        if "unrelated histories" in err:
            raise Failure(
                "upstream and the fork share no history. Merge upstream once by hand "
                "(git merge --allow-unrelated-histories) and push that to the fork branch."
            )
        raise Failure(f"git merge-tree failed: {err}")
    fields = [p.decode(errors="surrogateescape") for p in proc.stdout.split(b"\0") if p]
    if proc.returncode == 0:
        return fields[0], []
    return None, fields[1:]


# ---------------------------------------------------------------------- manifest


@dataclass
class Patch:
    id: str
    summary: str
    paths: list[str]
    tests: list[str] = field(default_factory=list)
    upstream: str = "none"


@dataclass
class Manifest:
    upstream_url: str
    track: str
    branch: str
    sync_branch: str
    automerge: bool
    workflow_changes: str
    ignore: list[str]
    patches: list[Patch]
    path: str

    @property
    def track_kind(self) -> str:
        return self.track.split(":", 1)[0]

    @property
    def track_arg(self) -> str:
        return self.track.split(":", 1)[1] if ":" in self.track else ""


def load_manifest(path: str) -> Manifest:
    p = Path(path)
    if not p.is_file():
        raise Failure(f"no manifest at {path}")
    try:
        data = tomllib.loads(p.read_text())
    except tomllib.TOMLDecodeError as e:
        raise Failure(f"{path}: {e}") from e
    errors: list[str] = []
    up = data.get("upstream", {})
    fork = data.get("fork", {})
    url = up.get("url", "")
    track = up.get("track", "")
    if not url:
        errors.append("[upstream] url is required")
    kind = track.split(":", 1)[0]
    if kind not in ("branch", "tag", "release"):
        errors.append('[upstream] track must be "branch:<name>", "tag:<regex>" or "release"')
    elif kind in ("branch", "tag") and ":" not in track:
        errors.append(f'[upstream] track "{track}" needs an argument')
    elif kind == "branch" and not SAFE_REF.fullmatch(track.split(":", 1)[1]):
        errors.append("[upstream] track branch name has unsupported characters")
    elif kind == "tag":
        try:
            re.compile(track.split(":", 1)[1])
        except re.error as e:
            errors.append(f"[upstream] track regex: {e}")
    elif kind == "release" and github_slug(url) is None:
        errors.append('[upstream] track "release" needs a github.com url')
    branch = fork.get("branch", "")
    if not branch:
        errors.append("[fork] branch is required")
    elif not SAFE_REF.fullmatch(branch):
        errors.append("[fork] branch name has unsupported characters")
    sync_branch = fork.get("sync_branch", "fork-kit/sync")
    if sync_branch == branch:
        errors.append("[fork] sync_branch must differ from branch")
    elif not SAFE_REF.fullmatch(sync_branch):
        errors.append("[fork] sync_branch name has unsupported characters")
    workflow_changes = fork.get("workflow_changes", "hold")
    if workflow_changes not in ("hold", "push"):
        errors.append('[fork] workflow_changes must be "hold" or "push"')
    patches: list[Patch] = []
    seen: set[str] = set()
    for i, raw in enumerate(data.get("patch", [])):
        pid = raw.get("id", "")
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", pid):
            errors.append(f"[[patch]] #{i + 1}: id must match [a-z0-9][a-z0-9._-]*")
        elif pid in seen:
            errors.append(f"[[patch]] {pid}: duplicate id")
        seen.add(pid)
        if not raw.get("paths"):
            errors.append(f"[[patch]] {pid or i + 1}: paths is required")
        unknown = set(raw) - {"id", "summary", "paths", "tests", "upstream"}
        if unknown:
            errors.append(f"[[patch]] {pid or i + 1}: unknown keys {sorted(unknown)}")
        patches.append(
            Patch(
                id=pid,
                summary=raw.get("summary", ""),
                paths=list(raw.get("paths", [])),
                tests=list(raw.get("tests", [])),
                upstream=raw.get("upstream", "none"),
            )
        )
    if errors:
        raise Failure(f"{path}:\n  " + "\n  ".join(errors))
    ledger = data.get("ledger", {})
    return Manifest(
        upstream_url=url,
        track=track,
        branch=branch,
        sync_branch=sync_branch,
        automerge=bool(fork.get("automerge", True)),
        workflow_changes=workflow_changes,
        ignore=[*ledger.get("ignore", []), p.name],
        patches=patches,
        path=path,
    )


def glob_match(pattern: str, path: str) -> bool:
    """Match a repo path against a glob where ** crosses directories and * does not."""
    regex = ""
    i = 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            regex += "(?:.*/)?"
            i += 3
        elif pattern.startswith("**", i):
            regex += ".*"
            i += 2
        elif pattern[i] == "*":
            regex += "[^/]*"
            i += 1
        elif pattern[i] == "?":
            regex += "[^/]"
            i += 1
        else:
            regex += re.escape(pattern[i])
            i += 1
    return re.fullmatch(regex, path, re.DOTALL) is not None


def patches_for(manifest: Manifest, path: str) -> list[str]:
    return [p.id for p in manifest.patches if any(glob_match(g, path) for g in p.paths)]


def github_slug(url: str) -> str | None:
    m = re.match(r"^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+?)(?:\.git)?/?$", url)
    return m.group(1) if m else None


def md(text: str) -> str:
    """Escape text from git (paths, refs) for markdown, so it can't break tables or hide content."""
    text = text.replace("\r", " ").replace("\n", " ")
    return re.sub(r"([\\`*_{}\[\]<>()#+\-.!|~])", r"\\\1", text)


# ------------------------------------------------------------------------- forge


class Forge:
    """The few pull request operations fork-kit needs."""

    def latest_release(self, url: str) -> str: ...
    def find_pr(self, head: str, base: str) -> dict | None: ...
    def create_pr(self, head: str, base: str, title: str, body: str) -> dict: ...
    def update_pr(self, number: int, title: str, body: str) -> None: ...
    def labels(self, number: int, add: list[str], remove: list[str]) -> None: ...
    def automerge(self, number: int, enable: bool) -> str | None: ...
    def comments(self, number: int) -> list[str]: ...
    def comment(self, number: int, body: str) -> None: ...
    def checks(self, sha: str) -> str: ...


class GitHub(Forge):
    def __init__(self, repo: str | None = None):
        self.repo = repo or os.environ.get("GITHUB_REPOSITORY") or self._origin_slug()
        self._labels_ready = False

    @staticmethod
    def _origin_slug() -> str:
        slug = github_slug(git("remote", "get-url", "origin"))
        if not slug:
            raise Failure("origin is not a github.com repository; set GITHUB_REPOSITORY")
        return slug

    def _gh(self, *args: str, input: str | None = None, check: bool = True) -> subprocess.CompletedProcess:
        proc = subprocess.run(["gh", *args], check=False, capture_output=True, text=True, input=input)
        if check and proc.returncode != 0:
            raise Failure(f"gh {' '.join(args[:4])} failed: {proc.stderr.strip()}")
        return proc

    def _api(self, method: str, path: str, body: dict | None = None, check: bool = True):
        args = ["api", "-X", method, path, "-H", "Accept: application/vnd.github+json"]
        if body is not None:
            args += ["--input", "-"]
        proc = self._gh(*args, input=json.dumps(body) if body is not None else None, check=check)
        if proc.returncode != 0:
            return None
        return json.loads(proc.stdout) if proc.stdout.strip() else None

    def _paginate(self, path: str, jq: str) -> list:
        """GET every page of `path`; `jq` selects the items, one per line."""
        proc = self._gh("api", "--paginate", path, "--jq", f"{jq} | @json")
        return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]

    def latest_release(self, url: str) -> str:
        return self._api("GET", f"repos/{github_slug(url)}/releases/latest")["tag_name"]

    def _pr(self, raw: dict) -> dict:
        return {
            "number": raw["number"],
            "url": raw["html_url"],
            "labels": [label["name"] for label in raw.get("labels", [])],
            "automerge": raw.get("auto_merge") is not None,
        }

    def find_pr(self, head: str, base: str) -> dict | None:
        owner = self.repo.split("/")[0]
        q = urllib.parse.urlencode({"head": f"{owner}:{head}", "base": base, "state": "open"})
        found = self._api("GET", f"repos/{self.repo}/pulls?{q}")
        return self._pr(found[0]) if found else None

    def create_pr(self, head: str, base: str, title: str, body: str) -> dict:
        raw = self._api("POST", f"repos/{self.repo}/pulls", {"head": head, "base": base, "title": title, "body": body})
        return self._pr(raw)

    def update_pr(self, number: int, title: str, body: str) -> None:
        self._api("PATCH", f"repos/{self.repo}/pulls/{number}", {"title": title, "body": body})

    def labels(self, number: int, add: list[str], remove: list[str]) -> None:
        if add and not self._labels_ready:
            for name, (color, desc) in LABELS.items():
                self._api("POST", f"repos/{self.repo}/labels", {"name": name, "color": color, "description": desc}, check=False)
            self._labels_ready = True
        if add:
            self._api("POST", f"repos/{self.repo}/issues/{number}/labels", {"labels": add})
        for name in remove:
            self._api("DELETE", f"repos/{self.repo}/issues/{number}/labels/{urllib.parse.quote(name, safe='')}", check=False)

    def automerge(self, number: int, enable: bool) -> str | None:
        flag = ["--auto", "--merge"] if enable else ["--disable-auto"]
        proc = self._gh("pr", "merge", str(number), "-R", self.repo, *flag, check=False)
        if proc.returncode != 0:
            return proc.stderr.strip() or f"gh pr merge exited {proc.returncode}"
        return None

    def comments(self, number: int) -> list[str]:
        return self._paginate(f"repos/{self.repo}/issues/{number}/comments?per_page=100", ".[].body")

    def comment(self, number: int, body: str) -> None:
        self._api("POST", f"repos/{self.repo}/issues/{number}/comments", {"body": body})

    def _own_runs(self, sha: str) -> set[int]:
        """Runs of the workflow fork-kit itself runs in, so its own jobs don't count as the fork's checks."""
        ref = os.environ.get("GITHUB_WORKFLOW_REF", "")
        m = re.match(r"^[^/]+/[^/]+/(.+?)@", ref)
        if not m:
            return set()
        runs = self._paginate(f"repos/{self.repo}/actions/runs?head_sha={sha}&per_page=100", ".workflow_runs[]")
        return {r["id"] for r in runs if r.get("path") == m.group(1)}

    def checks(self, sha: str) -> str:
        try:
            own = self._own_runs(sha)
            runs = self._paginate(f"repos/{self.repo}/commits/{sha}/check-runs?per_page=100", ".check_runs[]")
            status = self._api("GET", f"repos/{self.repo}/commits/{sha}/status")
        except Failure:
            return "error"
        own_urls = tuple(f"/actions/runs/{i}/" for i in own)
        items = [
            (r["status"], r.get("conclusion"))
            for r in runs
            if not (own_urls and any(u in (r.get("details_url") or "") for u in own_urls))
        ]
        for s in (status or {}).get("statuses", []):
            state = s.get("state")
            items.append(
                ("completed", "failure")
                if state in ("failure", "error")
                else ("completed", "success")
                if state == "success"
                else ("queued", None)
            )
        return summarize_checks(items)


def summarize_checks(runs: list[tuple[str, str | None]]) -> str:
    if not runs:
        return "unknown"
    if any(s == "completed" and c in ("failure", "timed_out", "action_required", "startup_failure") for s, c in runs):
        return "failure"
    if any(s != "completed" for s, _ in runs):
        return "pending"
    return "success"


class FakeForge(Forge):
    """A forge kept in a JSON file, for tests and local experiments."""

    def __init__(self, path: str):
        self.path = Path(path)
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.state.setdefault("prs", [])
        self.state.setdefault("calls", [])

    def _save(self, call: str, **kw):
        self.state["calls"].append({"call": call, **kw})
        self.path.write_text(json.dumps(self.state, indent=2))

    def latest_release(self, url: str) -> str:
        return self.state["releases"][url]

    def find_pr(self, head: str, base: str) -> dict | None:
        for pr in self.state["prs"]:
            if pr["head"] == head and pr["base"] == base and pr["state"] == "open":
                return pr
        return None

    def create_pr(self, head: str, base: str, title: str, body: str) -> dict:
        n = len(self.state["prs"]) + 1
        pr = {
            "number": n,
            "url": f"fake://pr/{n}",
            "head": head,
            "base": base,
            "title": title,
            "body": body,
            "labels": [],
            "automerge": False,
            "comments": [],
            "state": "open",
        }
        self.state["prs"].append(pr)
        self._save("create_pr", number=n)
        return pr

    def _get(self, number: int) -> dict:
        return next(p for p in self.state["prs"] if p["number"] == number)

    def update_pr(self, number: int, title: str, body: str) -> None:
        pr = self._get(number)
        pr["title"], pr["body"] = title, body
        self._save("update_pr", number=number)

    def labels(self, number: int, add: list[str], remove: list[str]) -> None:
        pr = self._get(number)
        pr["labels"] = sorted((set(pr["labels"]) | set(add)) - set(remove))
        self._save("labels", number=number, add=add, remove=remove)

    def automerge(self, number: int, enable: bool) -> str | None:
        self._get(number)["automerge"] = enable
        self._save("automerge", number=number, enable=enable)
        return None

    def comments(self, number: int) -> list[str]:
        return list(self._get(number)["comments"])

    def comment(self, number: int, body: str) -> None:
        self._get(number)["comments"].append(body)
        self._save("comment", number=number)

    def checks(self, sha: str) -> str:
        return self.state.get("checks", {}).get(sha, "unknown")


def make_forge() -> Forge:
    spec = os.environ.get("FORK_KIT_FORGE", "github")
    if spec.startswith("fake:"):
        return FakeForge(spec[5:])
    if spec == "github":
        return GitHub()
    raise Failure(f"unknown FORK_KIT_FORGE {spec!r}")


# ------------------------------------------------------------------------- state


def natural_key(s: str):
    return [(0, int(t), "") if t.isdigit() else (1, 0, t) for t in re.split(r"(\d+)", s) if t]


def resolve_upstream(m: Manifest, forge: Forge) -> tuple[str, str]:
    """Return (ref name, sha) of the upstream commit to track, fetched into UPSTREAM_REF."""
    kind, arg = m.track_kind, m.track_arg
    if kind == "branch":
        ref, src = arg, f"refs/heads/{arg}"
    else:
        if kind == "release":
            tag = forge.latest_release(m.upstream_url)
        else:
            listing = git("ls-remote", "--tags", "--refs", m.upstream_url)
            tags = [line.split("refs/tags/", 1)[1] for line in listing.splitlines() if "refs/tags/" in line]
            matching = [t for t in tags if re.fullmatch(arg, t)]
            if not matching:
                raise Failure(f"no upstream tag matches {arg!r}")
            tag = max(matching, key=natural_key)
        ref, src = tag, f"refs/tags/{tag}"
    if not SAFE_REF.fullmatch(ref):
        raise Failure(f"upstream ref {ref!r} has characters fork-kit does not accept")
    git("fetch", "--quiet", "--no-tags", m.upstream_url, f"+{src}:{UPSTREAM_REF}")
    return ref, git("rev-parse", f"{UPSTREAM_REF}^{{commit}}")


def fetch_fork(m: Manifest) -> tuple[str, str | None]:
    """Fetch the fork branch and the sync branch from origin; return their shas."""
    git("fetch", "--quiet", "--no-tags", "origin", f"+refs/heads/{m.branch}:refs/fork-kit/fork")
    fork = git("rev-parse", "refs/fork-kit/fork")
    remote = git("ls-remote", "origin", f"refs/heads/{m.sync_branch}")
    sync = None
    if remote:
        git("fetch", "--quiet", "--no-tags", "origin", f"+refs/heads/{m.sync_branch}:refs/fork-kit/sync")
        sync = git("rev-parse", "refs/fork-kit/sync")
    return fork, sync


def identity() -> dict:
    name = os.environ.get("FORK_KIT_GIT_NAME", "fork-kit[bot]")
    email = os.environ.get("FORK_KIT_GIT_EMAIL", "fork-kit[bot]@users.noreply.github.com")
    return {"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email, "GIT_COMMITTER_NAME": name, "GIT_COMMITTER_EMAIL": email}


def classify_sync(sync: str, fork: str) -> str:
    """What the sync branch head is.

    "pure": exactly the commit fork-kit would build: its trailer, its committer,
    upstream (plus a fork commit already on the fork branch) as parents, and the
    tree fork-kit computes for them. "stale": the same, but its fork parent is no
    longer on the fork branch (the fork branch was force-moved). "foreign":
    anything else, i.e. someone else's work.
    """
    recorded = trailer_value(sync, TRAILER)
    if not recorded or not git_ok("cat-file", "-e", f"{recorded}^{{commit}}"):
        return "foreign"
    if git("log", "-1", "--format=%ce", sync) != identity()["GIT_COMMITTER_EMAIL"]:
        return "foreign"
    parents = parents_of(sync)
    tree = git("rev-parse", f"{sync}^{{tree}}")
    if parents == [recorded]:
        return "pure" if tree == git("rev-parse", f"{recorded}^{{tree}}") else "foreign"
    if len(parents) == 2 and parents[1] == recorded:
        expected, _ = merge_tree(parents[0], recorded)
        if expected != tree:
            return "foreign"
        return "pure" if git_ok("merge-base", "--is-ancestor", parents[0], fork) else "stale"
    return "foreign"


@dataclass
class Plan:
    outcome: str  # up-to-date | clean | conflict | hands-off
    upstream_ref: str
    upstream_sha: str
    fork_sha: str
    base: str
    behind: int
    conflicts: list[dict]
    workflow_changes: list[str]
    sync_sha: str | None
    sync_state: str  # none | pure | stale | foreign
    notes: list[str] = field(default_factory=list)

    @property
    def pure(self) -> bool:
        return self.sync_state != "foreign"


def plan(m: Manifest, forge: Forge) -> Plan:
    if git_version() < MIN_GIT:
        raise Failure(f"git >= {MIN_GIT[0]}.{MIN_GIT[1]} is required")
    if git("rev-parse", "--is-shallow-repository") == "true":
        raise Failure("this is a shallow clone; fork-kit needs full history (actions/checkout with fetch-depth: 0)")
    ref, up = resolve_upstream(m, forge)
    fork, sync = fetch_fork(m)
    sync_state = "none" if sync is None else classify_sync(sync, fork)
    if git_ok("merge-base", "--is-ancestor", up, fork):
        return Plan("up-to-date", ref, up, fork, git("merge-base", fork, up), 0, [], [], sync, sync_state)
    base = git("merge-base", fork, up, check=False)
    if not base:
        merge_tree(fork, up)  # raises the unrelated-histories message
    behind = len(rev_list(up, f"^{fork}"))
    workflows = git_paths("diff", "--name-only", "--no-renames", base, up, "--", ".github")
    _, conflicted = merge_tree(fork, up)
    conflicts = [{"path": p, "patches": patches_for(m, p)} for p in conflicted]
    outcome = "conflict" if conflicts else "clean"
    if sync_state == "foreign":
        outcome = "hands-off"
    p = Plan(outcome, ref, up, fork, base, behind, conflicts, workflows, sync, sync_state)
    if sync_state == "stale":
        p.notes.append(f"the sync branch was built on a {m.branch} commit that is no longer on {m.branch}; rebuilding")
    return p


# -------------------------------------------------------------------------- sync


def build_sync_commit(m: Manifest, p: Plan) -> str:
    """The commit the sync branch should point at: the merge, or upstream plus a marker when it conflicts."""
    if p.outcome == "clean":
        tree, _ = merge_tree(p.fork_sha, p.upstream_sha)
        parents = ["-p", p.fork_sha, "-p", p.upstream_sha]
        head = f"Merge upstream {p.upstream_ref} into {m.branch}"
    else:
        tree = git("rev-parse", f"{p.upstream_sha}^{{tree}}")
        parents = ["-p", p.upstream_sha]
        head = f"Upstream {p.upstream_ref} for {m.branch} (conflicts: resolve by merging {m.branch} here)"
    msg = f"{head}\n\nUpstream: {m.upstream_url} {p.upstream_ref}\n\n{TRAILER}: {p.upstream_sha}\n"
    return git("commit-tree", tree, *parents, "-F", "-", env=identity(), input=msg)


def sync_current(p: Plan) -> bool:
    """Is the existing sync branch already what this plan would push?"""
    if p.sync_state != "pure" or trailer_value(p.sync_sha, TRAILER) != p.upstream_sha:
        return False
    want = [p.fork_sha, p.upstream_sha] if p.outcome == "clean" else [p.upstream_sha]
    return parents_of(p.sync_sha) == want


def pr_title(m: Manifest, p: Plan) -> str:
    return f"fork-kit: merge upstream {p.upstream_ref} ({p.upstream_sha[:8]}) into {m.branch}"


def pr_body(m: Manifest, p: Plan, baseline: str, automerge: bool, why_not: list[str]) -> str:
    slug = github_slug(m.upstream_url)
    rng = f"`{p.base[:8]}..{p.upstream_sha[:8]}`"
    if slug:
        rng = f"[{rng}](https://github.com/{slug}/compare/{p.base}...{p.upstream_sha})"
    lines = [
        MARKER,
        f"Merges upstream **{p.upstream_ref}** into `{m.branch}`: {rng}, {p.behind} new upstream commit(s).",
        "",
    ]
    if p.conflicts:
        lines += [
            "### Conflicts",
            "",
            "| Path | Patches |",
            "|---|---|",
            *[f"| {md(c['path'])} | {', '.join(c['patches']) or '_not in the ledger_'} |" for c in p.conflicts],
            "",
            (
                f"Resolve by merging `{m.branch}` into this branch (`fork-kit resolve`, or GitHub's conflict editor), "
                "keeping each patch's intent and its tests. Once you push, fork-kit stops updating this branch; "
                "close the PR to let it start over."
            ),
            "",
        ]
    if p.workflow_changes:
        lines += ["### Upstream changed workflows", "", *[f"- {md(w)}" for w in p.workflow_changes], ""]
    lines += [f"Checks on `{m.branch}` (`{p.fork_sha[:8]}`): **{baseline}**."]
    if automerge:
        lines += ["fork-kit requests auto-merge: this merges once the required checks pass."]
    elif why_not:
        lines += ["No auto-merge: " + "; ".join(why_not) + "."]
    return "\n".join(lines) + "\n"


def cmd_sync(args, m: Manifest, forge: Forge) -> dict:
    p = plan(m, forge)
    result = report_base("sync", m, p)
    if p.outcome == "up-to-date":
        result["notes"].append("upstream is already merged")
        return result
    pr = forge.find_pr(m.sync_branch, m.branch)

    if p.outcome == "hands-off":
        if pr is None:
            # Someone else's sync branch with no open PR: closed or abandoned. Start over.
            p.sync_state = "stale"
            p.outcome = "conflict" if p.conflicts else "clean"
            result.update(outcome=p.outcome)
            result["sync_branch"]["state"] = "stale"
            result["notes"].append("the sync branch has commits fork-kit did not make and no open PR; starting over")
        else:
            result["pr"] = {"number": pr["number"], "url": pr["url"]}
            if git_ok("merge-base", "--is-ancestor", p.upstream_sha, p.sync_sha):
                result["notes"].append("the hand-edited sync branch already contains this upstream")
            else:
                tag = f"<!-- fork-kit:upstream {p.upstream_sha} -->"
                if not args.dry_run and not any(tag in c for c in forge.comments(pr["number"])):
                    forge.comment(
                        pr["number"],
                        f"{tag}\nUpstream moved to **{p.upstream_ref}** (`{p.upstream_sha[:8]}`). This branch has "
                        "commits fork-kit did not make, so it leaves the branch alone: merge the new upstream here, "
                        "or close this PR to let fork-kit start over.",
                    )
            if not args.dry_run:
                if pr["automerge"]:
                    forge.automerge(pr["number"], False)
                if LABEL_OWNER not in pr["labels"]:
                    forge.labels(pr["number"], [LABEL_OWNER], [])
            return result

    if p.workflow_changes and m.workflow_changes == "hold" and not args.allow_workflow_changes:
        # Pushing these would make GitHub run upstream's new workflows in this repository.
        result.update(outcome="workflow-review")
        result["notes"].append(
            "upstream changed .github/; nothing pushed. Review the listed files, then run sync with "
            "--allow-workflow-changes (the workflow's allow-workflow-changes input)"
        )
        return result

    baseline = forge.checks(p.fork_sha)
    why_not = []
    if not m.automerge:
        why_not.append("disabled in the manifest")
    if pr and LABEL_HOLD in pr["labels"]:
        why_not.append(f"held with the {LABEL_HOLD} label")
    if p.conflicts:
        why_not.append("merge conflicts")
    if p.workflow_changes:
        why_not.append("upstream changed .github/")
    if baseline == "failure":
        why_not.append(f"`{m.branch}` itself is failing its checks")
    if baseline == "error":
        why_not.append(f"could not read the checks of `{m.branch}`")
    automerge = not why_not
    result.update(baseline=baseline, automerge=automerge, automerge_blocked_by=why_not)

    if args.dry_run:
        result["notes"].append("dry run: nothing pushed")
        return result

    if not sync_current(p):
        commit = build_sync_commit(m, p)
        lease = f"--force-with-lease=refs/heads/{m.sync_branch}:{p.sync_sha or ''}"
        git("push", "--quiet", lease, "origin", f"{commit}:refs/heads/{m.sync_branch}")
        result["sync_branch"].update(sha=commit, state="pure")
        result["notes"].append(f"pushed {m.sync_branch} at {commit[:8]}")

    title, body = pr_title(m, p), pr_body(m, p, baseline, automerge, why_not)
    if pr is None:
        pr = forge.create_pr(m.sync_branch, m.branch, title, body)
    else:
        forge.update_pr(pr["number"], title, body)
    want = {LABEL_CONFLICT: bool(p.conflicts), LABEL_WORKFLOWS: bool(p.workflow_changes), LABEL_OWNER: False}
    forge.labels(
        pr["number"],
        [label for label, on in want.items() if on and label not in pr["labels"]],
        [label for label, on in want.items() if not on and label in pr["labels"]],
    )
    if pr["automerge"] != automerge:
        err = forge.automerge(pr["number"], automerge)
        if err:
            result["automerge"] = pr["automerge"]
            result["notes"].append(f"could not {'enable' if automerge else 'disable'} auto-merge: {err}")
    result["pr"] = {"number": pr["number"], "url": pr["url"]}
    return result


def cmd_guard(args, m: Manifest, forge: Forge) -> dict:
    """On pushes to the sync PR: if anyone but fork-kit pushed, switch auto-merge off and keep out."""
    head_ref = os.environ.get("GITHUB_HEAD_REF")
    if head_ref and head_ref != m.sync_branch:
        return {"schema": SCHEMA, "tool": f"fork-kit {VERSION}", "command": "guard", "outcome": "not-sync-pr",
                "notes": [f"{head_ref} is not {m.sync_branch}"]}  # fmt: skip
    p = plan(m, forge)
    result = report_base("guard", m, p)
    pr = forge.find_pr(m.sync_branch, m.branch)
    if pr is None or p.sync_sha is None:
        result["notes"].append("no open sync PR")
        return result
    result["pr"] = {"number": pr["number"], "url": pr["url"]}
    result["automerge"] = pr["automerge"]
    if p.pure:
        result["notes"].append("the sync branch holds only fork-kit's commit")
        return result
    result.update(outcome="hands-off", automerge=False)
    if not args.dry_run:
        if pr["automerge"]:
            forge.automerge(pr["number"], False)
        if LABEL_OWNER not in pr["labels"]:
            forge.labels(pr["number"], [LABEL_OWNER], [])
    result["notes"].append("someone else pushed to the sync branch: auto-merge off")
    return result


def cmd_status(args, m: Manifest, forge: Forge) -> dict:
    p = plan(m, forge)
    r = report_base("status", m, p)
    r["baseline"] = forge.checks(p.fork_sha)
    return r


def cmd_ledger(args, m: Manifest, forge: Forge) -> dict:
    p = plan(m, forge)
    r = report_base("ledger", m, p)
    changed = git_paths("diff", "--name-only", "--no-renames", p.base, p.fork_sha) if p.base else []
    counted = [f for f in changed if not any(glob_match(g, f) for g in m.ignore)]
    uncovered = [f for f in counted if not patches_for(m, f)]
    stale = [pt.id for pt in m.patches if not any(glob_match(g, f) for g in pt.paths for f in counted)]
    r["ledger"] = {"changed": len(counted), "uncovered": uncovered, "stale": stale}
    if args.strict and (uncovered or stale):
        r["exit"] = 1
    return r


def cmd_resolve(args, m: Manifest, forge: Forge) -> dict:
    """Locally: check out the sync branch and merge the fork into it, leaving conflicts to resolve."""
    if git("status", "--porcelain"):
        raise Failure("the working tree has changes; commit or stash them first")
    p = plan(m, forge)
    r = report_base("resolve", m, p)
    if p.sync_sha is None:
        raise Failure(f"origin has no {m.sync_branch}; run fork-kit sync first")
    git("checkout", "--quiet", "-B", m.sync_branch, p.sync_sha)
    proc = subprocess.run(["git", "merge", "--no-ff", "--no-edit", p.fork_sha], check=False, capture_output=True, text=True)
    if proc.returncode == 0:
        r["conflicts"] = []
        r["notes"].append(f"merged {m.branch} cleanly; review, test and push {m.sync_branch}")
        return r
    files = git_paths("diff", "--name-only", "--diff-filter=U")
    r["conflicts"] = [{"path": f, "patches": patches_for(m, f)} for f in files]
    by_id = {pt.id: pt for pt in m.patches}
    for c in r["conflicts"]:
        print(f"CONFLICT {c['path']}")
        for pid in c["patches"]:
            pt = by_id[pid]
            print(f"  patch {pid}: {pt.summary}")
            if pt.tests:
                print(f"    tests: {', '.join(pt.tests)}")
            if pt.upstream != "none":
                print(f"    upstream: {pt.upstream}")
    r["notes"].append(f"resolve the conflicts, `git commit`, then `git push origin {m.sync_branch}`")
    return r


def report_base(command: str, m: Manifest, p: Plan) -> dict:
    return {
        "schema": SCHEMA,
        "tool": f"fork-kit {VERSION}",
        "command": command,
        "outcome": p.outcome,
        "upstream": {"url": m.upstream_url, "track": m.track, "ref": p.upstream_ref, "sha": p.upstream_sha},
        "fork": {"branch": m.branch, "sha": p.fork_sha},
        "base": p.base or None,
        "behind": p.behind,
        "conflicts": p.conflicts,
        "workflow_changes": p.workflow_changes,
        "sync_branch": {"name": m.sync_branch, "sha": p.sync_sha, "state": p.sync_state},
        "pr": None,
        "automerge": False,
        "notes": list(p.notes),
    }


# ----------------------------------------------------------------------- output


def summary_markdown(r: dict) -> str:
    lines = [f"## fork-kit {r['command']}: {r['outcome']}", ""]
    if "upstream" in r:
        up = r["upstream"]
        lines += [
            f"- Upstream: {md(up['url'])} **{up['ref']}** `{up['sha'][:8]}` ({r['behind']} commit(s) not in the fork)",
            f"- Fork: `{r['fork']['branch']}` `{r['fork']['sha'][:8]}`",
        ]
    if r.get("pr"):
        lines.append(f"- Sync PR: {r['pr']['url']} (auto-merge {'requested' if r['automerge'] else 'off'})")
    for c in r.get("conflicts", []):
        lines.append(f"- Conflict: {md(c['path'])} ({', '.join(c['patches']) or 'not in the ledger'})")
    for w in r.get("workflow_changes", []):
        lines.append(f"- Upstream workflow change: {md(w)}")
    if "ledger" in r:
        lg = r["ledger"]
        lines.append(
            f"- Ledger: {lg['changed']} changed file(s); uncovered: {len(lg['uncovered'])}; stale patches: {lg['stale'] or 'none'}"
        )
        lines += [f"  - not in any patch: {md(f)}" for f in lg["uncovered"]]
    lines += [f"- {n}" for n in r["notes"]]
    return "\n".join(lines) + "\n"


def emit(r: dict, args) -> None:
    if args.report:
        Path(args.report).write_text(json.dumps(r, indent=2) + "\n")
    if args.json:
        print(json.dumps(r, indent=2))
    else:
        print(summary_markdown(r), end="")
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(summary_markdown(r))
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"outcome={r['outcome']}\n")
            f.write(f"upstream-ref={r.get('upstream', {}).get('ref', '')}\n")
            f.write(f"upstream-sha={r.get('upstream', {}).get('sha', '')}\n")
            f.write(f"pr-url={(r.get('pr') or {}).get('url', '')}\n")
            f.write(f"automerge={'true' if r.get('automerge') else 'false'}\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="fork-kit", description=__doc__.splitlines()[0])
    ap.add_argument("--version", action="version", version=f"fork-kit {VERSION}")
    ap.add_argument("--manifest", default=".fork-kit.toml", help="path to the manifest (default: .fork-kit.toml)")
    ap.add_argument("--report", help="also write the JSON result to this file")
    ap.add_argument("--json", action="store_true", help="print the JSON result instead of a summary")
    sub = ap.add_subparsers(dest="command", required=True)
    for name, helptext in [
        ("status", "show where the fork stands against upstream; changes nothing"),
        ("sync", "merge the newest upstream into the sync branch and keep its pull request current"),
        ("guard", "switch auto-merge off when someone other than fork-kit pushed to the sync branch"),
        ("ledger", "check that the patch ledger covers every file the fork changes"),
        ("resolve", "locally: check out the sync branch and merge the fork into it to resolve conflicts"),
    ]:
        sp = sub.add_parser(name, help=helptext, description=helptext)
        if name in ("sync", "guard"):
            sp.add_argument("--dry-run", action="store_true", help="decide, but push and change nothing")
        if name == "sync":
            sp.add_argument(
                "--allow-workflow-changes",
                action="store_true",
                help="push even though upstream changed .github/ (after reviewing those changes)",
            )
        if name == "ledger":
            sp.add_argument("--strict", action="store_true", help="exit 1 on uncovered files or stale patches")
    args = ap.parse_args(argv)
    try:
        m = load_manifest(args.manifest)
        forge = make_forge()
        handler = {"status": cmd_status, "sync": cmd_sync, "guard": cmd_guard, "ledger": cmd_ledger, "resolve": cmd_resolve}
        r = handler[args.command](args, m, forge)
    except Failure as e:
        print(f"fork-kit: {e}", file=sys.stderr)
        return 2
    code = r.pop("exit", 0)
    emit(r, args)
    if args.command == "resolve" and r["conflicts"]:
        return 1
    return code


if __name__ == "__main__":
    sys.exit(main())
