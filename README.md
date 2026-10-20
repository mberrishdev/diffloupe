# diffx

A local code review tool designed for the coding agent workflow. Review AI-generated changes in a GitHub PR-like web UI, leave inline comments, then hand them back to your coding agent to fix.

![screenshot](https://raw.githubusercontent.com/wong2/diffx/main/screenshot.png)

## Install

```bash
npm install -g diffx-cli
```

## Usage

Run in any git repository:

```bash
diffx
```

This starts a local server and opens your browser with a diff review UI.

### Options

```
diffx [options] [<repo-path>...] [-- <git-diff-args>]

Options:
  -p, --port <port>   Server port (default: 3433)
  --no-open           Don't auto-open browser

Examples:
  diffx                          # Review working tree changes
  diffx -p 8080                  # Use custom port
  diffx -- HEAD~3                # Diff against 3 commits ago
  diffx -- main..HEAD            # Diff between branches
  diffx -- --cached -- src/      # Staged changes in src/
  diffx ../api ../web            # Review several repositories in one session
  diffx ../api ../web -- HEAD~1  # git diff args apply to every repository
```

### Multiple repositories

Review several repos (or git worktrees) in one session, which is handy when coding agents work on them in parallel. Click the repo name in the toolbar to switch repos, see each repo's open comment count, remove a repo, or **Add repository…**. The picker suggests:

- git worktrees of the repos you have open
- repos you reviewed recently (remembered in `~/.config/diffx/recent-repos.json`)
- repos next to the ones you have open, or inside the folder you launched diffx from

Repos with uncommitted changes are listed first and marked with a green dot. You can also type or paste any path, such as `~/code/api`. Running `diffx` outside a git repository opens the picker directly, and you can still pass repo paths on the command line (`diffx ../api ../web`).

Adding and removing repos from the UI is only available when diffx listens on localhost (the default). With `--host 0.0.0.0` the repo list is fixed to the paths given at startup, so other machines can't open arbitrary repos on yours.

The selected repo is kept in the URL (`?repo=<id>`), so you can open one browser tab per repo. Comments and viewed state are tracked per repo (removing a repo deletes its comments), and "Copy comments" copies the current repo's comments with its path on the root element:

```xml
<code-review-comments repo="/home/me/code/api">
...
</code-review-comments>
```

## Features

- **Split / Unified view** — Toggle between side-by-side and inline diff
- **Syntax highlighting** — Powered by Shiki with GitHub themes
- **File tree** — Hierarchical file browser with search filter and file change-type icons
- **Inline comments** — Click the `+` button on any line to add a review comment
- **Comment replies** — AI agents can reply to comments via API, displayed with bot avatar in the UI
- **Comment status tracker** — Sidebar widget showing open, replied, and resolved comment counts with click-to-navigate links
- **Copy comments** — One-click copy all comments as structured XML for AI coding agents
- **Image preview** — Side-by-side comparison for added, modified, and deleted images
- **Viewed tracking** — Mark files as reviewed to track progress
- **Staged / Untracked toggles** — Choose which changes to include
- **Custom diff commands** — Pass any `git diff` arguments after `--`
- **Multiple repositories** — Add, switch between and remove repos or worktrees from the toolbar, with suggestions for nearby, worktree and recent repos
- **EditorConfig support** — Respects `.editorconfig` for per-file tab size
- **Persistent settings** — Your preferences are saved across sessions

## Comment Output Format

When you click "Copy comments", the output is structured XML optimized for AI agents:

```xml
<code-review-comments>
<file path="src/utils/parser.ts">
<comment line="42">
<code>+ const parsedToken = tokenize(input)</code>
Rename `x` to `parsedToken` for clarity.
</comment>
<comment line="15">
<code>- if (input != null) {</code>
This null check removal may cause a bug when `input` is undefined.
</comment>
</file>
</code-review-comments>
```

Each comment includes the commented code line with a `+`/`-` prefix indicating whether it's an added or removed line.

## Agent Skills

Install the diffx skills to use diffx directly from your AI coding agent:

```bash
npx skills add wong2/diffx
```

The review workflow uses two commands:

1. **`/diffx-start-review`** — Launches the diffx server and opens the browser. Review your changes and leave inline comments.
2. **`/diffx-finish-review`** — The agent fetches all comments from the running diffx server via API, applies the requested changes, and marks each comment as resolved. The browser UI updates in real time as comments are resolved.

## License

MIT
