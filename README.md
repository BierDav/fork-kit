# fork-kit

Keep a downstream fork merged with its upstream through **one sync pull request**.

You run a fork in production because it carries a few patches upstream doesn't
have (yet). Every upstream change then has to be merged in, tested, and
released, and every so often a merge conflicts or a patch stops working.
fork-kit makes that the same routine for every fork:

- A scheduled job merges the newest upstream (a branch, the newest matching
  tag, or the latest GitHub release) into a sync branch and keeps one pull
  request open for it.
- Your fork's CI and upstream's CI run on that PR. A clean merge with green
  checks can merge itself. Conflicts, red checks and upstream changes to
  `.github/` wait for a human.
- A **patch ledger** in the manifest says which files each of your patches owns,
  so a conflict says "patch `room-tags` conflicts in `src/tags.rs`", not just a
  file name.
- Every run writes a machine-readable result (`fork-kit-result.json`) that
  dashboards, alerting or a repair agent can act on.

fork-kit never rebases or force-pushes your fork branch. It merges, so the
history stays intact, and branch protection works without exceptions.

## How it works

```
upstream ──► fork-kit/sync ──PR──► your fork branch ──► your release workflow
             (fork-kit's own        (protected: PR,
              merge commit)          required checks)
```

On each run, `fork-kit sync`:

1. Resolves the upstream ref and fetches it, along with your fork branch and
   `fork-kit/sync`.
2. If upstream is already merged, stops.
3. If upstream changed anything under `.github/`, stops and reports
   `workflow-review` (unless the manifest says otherwise; see
   [Trust model](#trust-model)). You review those changes, then run the
   workflow with `allow-workflow-changes`.
4. Merges in memory (`git merge-tree`):
   - **Clean:** the sync branch becomes a merge commit of your fork branch and upstream.
   - **Conflicts:** the sync branch becomes upstream plus an empty marker commit, and the PR shows the conflicts.
5. Pushes the sync branch with `--force-with-lease` (it is fork-kit's scratch
   branch, never your fork branch), opens or updates the PR, labels it, and
   turns auto-merge on or off.

fork-kit recognises its own commit exactly: its trailer, its committer, its
parents and the tree it would build. Anything else on the sync branch is
someone else's work, for example a conflict resolution. fork-kit then leaves
the branch alone:

- `guard` turns auto-merge off and labels the PR `fork-kit:needs-owner`.
- Later syncs only comment when upstream moves again.
- Closing the PR lets fork-kit start over.

Auto-merge is requested only when all of these hold:

- the merge has no conflicts;
- upstream changed nothing under `.github/`;
- your fork branch's checks and commit statuses are not failing and could be read;
- the PR has no `fork-kit:hold` label;
- the manifest allows it.

### Holding a pull request

The guard sets the commit status `fork-kit/hold` on every pull request into
your fork branch, the sync PR and your own alike. It passes normally and fails
while the PR has the `fork-kit:hold` label; adding the label also turns
auto-merge off. Make `fork-kit/hold` a required check of the fork branch (see
Setup) and a held PR cannot merge, by hand or automatically, until the label
is removed. The guard reacts to the label at once (`labeled`, `unlabeled`).

Removing the label does not turn auto-merge back on: the guard runs with
`GITHUB_TOKEN`, and a merge it enabled would not start your release workflows.
The next `sync` run requests it again, or merge by hand.

The label holds one pull request. It does not stop what your release workflows
do after something else merges into the fork branch; hold deployments there.

## Trust model

Read this before you set it up.

- **fork-kit itself runs no code from your fork or from upstream.** The sync
  and guard jobs only run git plumbing (`merge-tree`, `commit-tree`, `push`)
  and the GitHub API.
- **But pushing the sync branch makes GitHub run the workflows in it.** Your
  CI tests upstream's code on the PR. That is the point, and it means
  upstream's code runs in your Actions.
- **Upstream's own workflow files run too** once they are on the sync branch.
  That is why fork-kit holds every upstream change to `.github/` until a human
  has looked at it (`workflow_changes = "hold"`, the default).

To keep that code away from what matters:

1. **Put the App key in an environment.** Store `FORK_KIT_APP_KEY` in an
   environment named `fork-kit` whose deployment branches are limited to your
   default branch, not in repository secrets. Workflows running on the sync
   branch then cannot read it.
2. **Do the same for publishing secrets.** Keep your release workflow's
   registry tokens in an environment limited to your fork branch.
3. **Make the default `GITHUB_TOKEN` read-only:** Settings → Actions →
   Workflow permissions.
4. **Leave the guard as the template has it.** It runs on
   `pull_request_target` with `GITHUB_TOKEN` and never checks out the PR, so
   nothing in the PR can change what it does.

## Setup

### 1. The manifest

Commit `.fork-kit.toml` to the branch your workflow runs on (usually the default branch):

```toml
[upstream]
url = "https://github.com/example/project.git"
track = "branch:main"          # or "tag:<regex>" (highest matching tag), or "release" (latest GitHub release)

[fork]
branch = "patched"             # your protected fork branch
# sync_branch = "fork-kit/sync"
# automerge = true
# workflow_changes = "hold"    # or "push": push upstream's .github/ changes without review

[ledger]
# Fork-only files that are not patches to upstream's code.
ignore = [".github/**", "Dockerfile.custom", "docs/fork.md"]

[[patch]]
id = "room-tags"
summary = "Accept flat tag bodies that Element sends"
paths = ["src/api/tags.rs", "tests/tags/**"]
tests = ["tests/tags/flat_body.rs"]
upstream = "https://github.com/example/project/issues/123"   # or "none"
```

`paths` are globs: `*` stays within a directory, `**` crosses directories.

For `tag:` tracking, the highest tag matching the regex wins, in natural sort
order. Write the regex so that it excludes prereleases you don't want, e.g.
`v\d+\.\d+\.\d+`.

### 2. A GitHub App

Create a GitHub App (Settings → Developer settings → GitHub Apps) with these
repository permissions and install it on the fork:

| Permission                  | Why                                                                  |
| --------------------------- | -------------------------------------------------------------------- |
| Contents: read & write      | push the sync branch                                                 |
| Pull requests: read & write | open, update and label the sync PR; turn auto-merge on and off       |
| Workflows: read & write     | push upstream commits that change `.github/workflows` (after review) |
| Checks: read                | read your fork branch's check runs                                   |
| Commit statuses: read       | read your fork branch's commit statuses                              |
| Actions: read               | tell fork-kit's own runs apart from your checks                      |

Store the App's ID as the repository variable `FORK_KIT_APP_ID`, and its
private key as `FORK_KIT_APP_KEY` in the `fork-kit` environment (see
[Trust model](#trust-model)).

Why not `GITHUB_TOKEN`: pushes and merges made with it start no workflows, so
the sync PR's checks would never run. It also cannot push changes to workflow
files.

### 3. Repository settings

- **Allow auto-merge** (Settings → General).
- Allow **merge commits**; fork-kit requests auto-merge with the merge method.
  Squash or rebase would throw away upstream's history.
- A **ruleset** on your fork branch: require a pull request, require your test
  and build checks and `fork-kit/hold`, block force pushes and deletions.
  Without required checks, auto-merge would merge immediately. Add
  `fork-kit/hold` only once the guard from the template runs on the fork
  branch; until then nothing sets it and no PR could merge.

### 4. The workflow

Copy [`examples/fork-kit.yml`](examples/fork-kit.yml) to
`.github/workflows/fork-kit.yml`, set your fork branch, and pin `BierDav/fork-kit` to a
commit SHA. Your existing test, build and release workflows stay as they are.
Make sure they run:

- on `pull_request` into the fork branch: tests and build, no publishing;
- on `push` to it: release.

## Commands

```
fork-kit [--manifest PATH] [--json] [--report FILE] COMMAND
```

| Command                                       | What it does                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                      | Where the fork stands against upstream. Changes nothing.                                                                        |
| `sync [--dry-run] [--allow-workflow-changes]` | Merge the newest upstream into the sync branch and keep the PR current.                                                         |
| `guard [--dry-run]`                           | Set `fork-kit/hold` on the triggering PR; turn auto-merge off if it is held or someone else pushed to the sync branch.          |
| `ledger [--strict]`                           | List changed files no patch claims, and patches that claim no changed file (possibly upstreamed).                               |
| `resolve`                                     | Locally: check out the sync branch, merge your fork branch into it, and list conflicting files with the patches they belong to. |

Exit codes:

- `0`: success.
- `1`: `ledger --strict` found gaps, or `resolve` left conflicts.
- `2`: error.

The action runs on GitHub's own Node.js runtime and needs nothing installed
besides git ≥ 2.38 and a full-history checkout (no shallow clone).

Locally, run it from the repository with Node.js ≥ 22 or Bun:

```sh
npx --yes github:BierDav/fork-kit#v0.2.0 status
bunx github:BierDav/fork-kit#v0.2.0 status
```

It uses `GH_TOKEN` or `GITHUB_TOKEN` when set, and `gh auth token` otherwise.

### Resolving a conflict

```sh
git fetch origin
fork-kit resolve            # checks out fork-kit/sync and merges your fork branch into it
# fix the conflicts, keeping each patch's intent and running its tests
git commit
git push origin fork-kit/sync
```

GitHub's "Resolve conflicts" button does the same. The PR then waits for you to
merge it. While a PR has conflicts GitHub runs no `pull_request` checks on it;
the guard still runs, because it uses `pull_request_target`.

## The result file

Every command can write JSON (`--report`; the action writes
`fork-kit-result.json` and names it in its `report` output, which the example
workflow uploads as the artifact `fork-kit-result`):

```json
{
  "schema": 1,
  "command": "sync",
  "outcome": "conflict",
  "upstream": { "url": "…", "track": "branch:main", "ref": "main", "sha": "…" },
  "fork": { "branch": "patched", "sha": "…" },
  "base": "…",
  "behind": 12,
  "conflicts": [{ "path": "src/api/tags.rs", "patches": ["room-tags"] }],
  "workflow_changes": [],
  "sync_branch": { "name": "fork-kit/sync", "sha": "…", "state": "pure" },
  "pr": { "number": 42, "url": "…" },
  "automerge": false,
  "automerge_blocked_by": ["merge conflicts"],
  "baseline": "success",
  "notes": []
}
```

`outcome` is one of:

- `up-to-date`, `clean` or `conflict`;
- `hands-off`: a human owns the sync branch;
- `workflow-review`: upstream changed `.github/` and nothing was pushed;
- `not-sync-pr`: guard only, the PR is not the sync PR.

`sync_branch.state` is one of:

- `none`: there is no sync branch;
- `pure`: fork-kit's own commit;
- `stale`: fork-kit's commit on a fork branch that was force-moved; it gets rebuilt;
- `foreign`: someone else's work.

## Limitations

- **GitHub only, for now.** Upstream can be any git URL, except that `release`
  tracking needs a github.com upstream.
- **One upstream and one fork branch** per manifest.
- **Building, testing and releasing are up to your workflows.** fork-kit only
  decides when a merge is safe to take.
- **A small race:** someone with write access pushes to the sync PR while
  auto-merge is on, and the required checks finish before the guard has run.
  Add the `fork-kit:hold` label before you push to rule this out: with
  `fork-kit/hold` required, the PR cannot merge while it is held.

## Prior art

- **Merge or rebase whole branches:** [wei/pull](https://github.com/wei/pull) and GitHub's fork sync.
- **Patch stacks kept as patch files:** quilt, [StGit](https://stacked-git.github.io/), [git-pile](https://github.com/git-pile/git-pile), Debian's `gbp pq`, and Electron's `patches/`.
- **Agent skills for fork upkeep:** [Cohere's vllm-skills](https://github.com/cohere-ai/vllm-skills) and [downstream-fork-maintain-skill](https://github.com/xz-dev/downstream-fork-maintain-skill).

fork-kit adds the parts these leave out: one protected-branch-friendly PR flow,
a patch ledger, and a machine-readable result per run.

## Development

fork-kit is TypeScript, developed with [Bun](https://bun.sh):

```sh
bun install
bun run typecheck && bun run lint && bun test
bun run build     # bundles src/ into dist/, which the action runs; commit it
```

The action ships as a single bundled file in `dist/` with no runtime
dependencies. CI rebuilds it and fails if the committed bundle differs from the
sources.

## License

[Apache License 2.0](LICENSE).
