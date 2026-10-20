# diffloupe

> A sharper lens on your diffs. Forked from [diffx](https://github.com/wong2/diffx) by [wong2](https://github.com/wong2), extended with multi-repo review, code navigation and more.

A local code review tool designed for the coding agent workflow. Review AI-generated changes in a GitHub PR-like web UI, leave inline comments, then hand them back to your coding agent to fix.

![screenshot](https://raw.githubusercontent.com/mberrishdev/diffloupe/main/screenshot.png)

## Install

```bash
npm install -g diffloupe
```

## Usage

Run in any git repository:

```bash
diffloupe
```

This starts a local server and opens your browser with a diff review UI.

### Options

```
diffloupe [options] [<repo-path>...] [-- <git-diff-args>]

Options:
  -p, --port <port>   Server port (default: 3433)
  --no-open           Don't auto-open browser

Examples:
  diffloupe                          # Review working tree changes
  diffloupe -p 8080                  # Use custom port
  diffloupe -- HEAD~3                # Diff against 3 commits ago
  diffloupe -- main..HEAD            # Diff between branches
  diffloupe -- --cached -- src/      # Staged changes in src/
  diffloupe ../api ../web            # Review several repositories in one session
  diffloupe ../api ../web -- HEAD~1  # git diff args apply to every repository
```

### Code navigation

⌘-click (Ctrl+click on Windows/Linux) a symbol in the diff to open the navigation panel, like "Go to Definition" / "Find All References" in VS Code. It lists the symbol's **definitions**, **implementations** (e.g. classes implementing an interface) and **references** (where it is called or used), grouped by file, and previews the selected location. ⌘-click symbols in the preview to keep exploring; the back arrow returns to the previous symbol.

Results come in two stages:

1. **Text matches** appear instantly for any language: a whole-word `git grep` over the work tree, with definitions and implementations recognised by pattern.
2. **Exact results** replace them when a language server is installed for the file's language. diffloupe starts it on first use and keeps it running for the session:

| Language | Language server | Install |
| --- | --- | --- |
| C# / .NET | csharp-ls | `dotnet tool install --global csharp-ls` |
| TypeScript / JavaScript | typescript-language-server | `npm install --global typescript-language-server typescript` |

You don't need to remember any of this: when you open a C# or TypeScript repository, diffloupe checks what exact navigation needs and shows a banner if something is missing. The chip next to the diff stats (e.g. **C# · Setup needed**, **C# · Loading solution…**, **C# · Exact navigation**) opens a setup checklist that covers:

- **C#:** a .NET SDK new enough for csharp-ls and for your projects' target frameworks, any SDK pinned by `global.json`, csharp-ls itself, a solution or project file, and restored NuGet packages
- **TypeScript/JavaScript:** typescript-language-server, the `typescript` package, and installed dependencies

Each missing item comes with the command to run, and steps that are safe to automate (installing the language server, `dotnet restore`, installing dependencies) have a **Run it for me** button. Once everything is in place, diffloupe starts the language server in the background so the project is loaded before your first click. Setup steps can only be run from the UI when diffloupe listens on localhost.

diffloupe finds `csharp-ls` in `~/.dotnet/tools` and `typescript-language-server` in the repo's `node_modules/.bin`, as well as on your `PATH`. Large .NET solutions can take a while to load; until then the panel shows text matches and upgrades automatically. Symbols on removed lines always use text matches, since those lines no longer exist on disk.

### Multiple repositories

Review several repos (or git worktrees) in one session, which is handy when coding agents work on them in parallel. Click the repo name in the toolbar to switch repos, see each repo's open comment count, remove a repo, or **Add repository…**. The picker suggests:

- git worktrees of the repos you have open
- repos you reviewed recently (remembered in `~/.config/diffloupe/recent-repos.json`)
- repos next to the ones you have open, or inside the folder you launched diffloupe from

Repos with uncommitted changes are listed first and marked with a green dot. You can also type or paste any path, such as `~/code/api`. Running `diffloupe` outside a git repository opens the picker directly, and you can still pass repo paths on the command line (`diffloupe ../api ../web`).

Adding and removing repos from the UI is only available when diffloupe listens on localhost (the default). With `--host 0.0.0.0` the repo list is fixed to the paths given at startup, so other machines can't open arbitrary repos on yours.

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
- **Code navigation** — ⌘/Ctrl-click any symbol to see its definition, implementations and references, with a file preview; exact results when a language server is installed
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

Install the diffloupe skills to use diffloupe directly from your AI coding agent:

```bash
npx skills add mberrishdev/diffloupe
```

The review workflow uses two commands:

1. **`/diffloupe-start-review`** — Launches the diffloupe server and opens the browser. Review your changes and leave inline comments.
2. **`/diffloupe-finish-review`** — The agent fetches all comments from the running diffloupe server via API, applies the requested changes, and marks each comment as resolved. The browser UI updates in real time as comments are resolved.

## License

MIT. Based on [diffx](https://github.com/wong2/diffx) by wong2; see [LICENSE](LICENSE).
