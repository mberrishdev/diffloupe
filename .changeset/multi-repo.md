---
'diffx-cli': minor
---

Review multiple git repositories in one session. Click the repo name in the toolbar to switch repos, remove one, or add another; the picker suggests git worktrees, recently used repos and nearby repos (those with changes first), or takes any path. Running `diffx` outside a repository opens the picker, and repo paths can also be passed on the command line (`diffx ../api ../web`). Comments and viewed state are tracked per repo, and comments now include `repoId` and `repoPath`.
