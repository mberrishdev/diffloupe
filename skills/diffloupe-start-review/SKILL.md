---
name: diffloupe-start-review
description: "Start a code review session by launching the diffloupe server and opening the browser UI. Use when the user invokes /diffloupe-start-review."
user_invocable: true
---

# Start diffloupe Review

Launch the diffloupe server so the user can review their git changes in a browser-based UI and leave inline comments.

## What to do

### 1. Launch diffloupe

Run `diffloupe` in the background. By default it shows all working tree changes (staged + unstaged + untracked).

```bash
diffloupe
```

Common variations — use these when the context calls for it:

```bash
diffloupe -- --staged          # Only staged changes
diffloupe -- HEAD~3            # Last 3 commits
diffloupe -- main..HEAD        # Current branch vs main
diffloupe -p 8080             # Custom port (default: random available port)
diffloupe ../api ../web       # Several repositories in one session (repo switcher in the UI)
```

The user can also add or remove repositories from the repo menu in the browser, so you don't need to restart diffloupe to review another repo.

Anything after `--` is passed directly to `git diff`, so any valid git diff arguments work.

**Important:** Run diffloupe in the background using the Bash tool with `run_in_background: true`, so the server stays alive while the user reviews.

### 2. Tell the user

After launching, tell the user:

> diffloupe is running. Review your changes in the browser and leave inline comments. When you're done, come back here and run `/diffloupe-finish-review`.

Keep it brief.
