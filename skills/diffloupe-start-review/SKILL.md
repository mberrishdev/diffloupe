---
name: diffloupe-start-review
description: "Start a code review session by launching the diffloupe server and opening the browser UI. Use when the user invokes /diffloupe-start-review."
user_invocable: true
---

# Start diffloupe Review

Launch the diffloupe server so the user can review their git changes in a browser-based UI and leave inline comments.

## What to do

### 1. Launch diffloupe

Run `diffloupe` in the repository. By default it shows all working tree changes (staged + unstaged + untracked).

```bash
diffloupe
```

This adds the repository to diffloupe's background server (starting it if needed), opens the browser and returns straight away, so a normal foreground Bash call is fine. Note the URL it prints, e.g. `http://127.0.0.1:4747/?repo=my-app`: the port and repo id are needed by `/diffloupe-finish-review`.

To review several repositories in one session:

```bash
diffloupe ../api ../web
```

The user can also add or remove repositories from the repo menu in the browser, so you don't need to rerun diffloupe to review another repo.

To review something other than the working tree, pass git diff arguments after `--`. Anything after `--` is passed directly to `git diff`:

```bash
diffloupe -- --staged          # Only staged changes
diffloupe -- HEAD~3            # Last 3 commits
diffloupe -- main..HEAD        # Current branch vs main
```

**Important:** with git diff arguments, diffloupe runs a separate server in the foreground instead (on a random port, printed as `diffloupe server running at http://127.0.0.1:<port>`). Run that form in the background using the Bash tool with `run_in_background: true`, so the server stays alive while the user reviews.

### 2. Tell the user

After launching, tell the user:

> diffloupe is running. Review your changes in the browser and leave inline comments. When you're done, come back here and run `/diffloupe-finish-review`.

Keep it brief.
