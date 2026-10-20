# diffloupe

> A sharper lens on your diffs. Forked from [diffx](https://github.com/wong2/diffx) by [wong2](https://github.com/wong2), extended with multi-repo review, code navigation and more.

A local code review tool designed for the coding agent workflow. Review AI-generated changes in a GitHub PR-like web UI, leave inline comments, then hand them back to your coding agent to fix.

What diffloupe adds on top of diffx:

- **[Code navigation](#code-navigation):** ⌘/Ctrl-click any name in the diff to see its definition, implementations and references, with exact results for C# and TypeScript/JavaScript
- **[Multiple repositories](#multiple-repositories):** review several repos or git worktrees in one session and switch between them from the toolbar

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
  -p, --port <port>   Server port (default: random available port)
  --host <host>       Host to bind to (default: 127.0.0.1). Use 0.0.0.0 to
                      expose the server on your local network
  --no-open           Don't auto-open browser
  -v, --version       Show version number
  -h, --help          Show help

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

A diff only shows the lines that changed. When a change calls a function or uses a type, you often need to see what that function does, or what else depends on it, before you can judge the change. Code navigation lets you jump there without leaving the review, like "Go to Definition" and "Find All References" in VS Code.

**How to use it:** hold ⌘ (Ctrl on Windows/Linux) and click any name in the diff: a function, variable, class, method or type. For example, in this changed line:

```ts
+ const user = await loadUser(id)
```

⌘-clicking `loadUser` opens a panel with:

- **Definitions:** where `loadUser` is written, e.g. `function loadUser(id) { … }` in `src/users.ts`
- **Implementations:** for an interface or abstract method, the classes that implement it
- **References:** every place in the project that calls or uses `loadUser`

Results are grouped by file. Select one to preview the file at that line. ⌘-click names inside the preview to keep exploring, and use the back arrow to return to the previous symbol.

#### Text matches and exact results

Results come in two stages:

1. **Text matches** appear instantly, for any language. diffloupe searches the repo for the same whole word and recognises definitions by pattern. This is fast but can include unrelated code that happens to use the same name.
2. **Exact results** replace them when a language server is installed for the file's language. This is the same engine your editor uses, so you get the real definition and the real callers. diffloupe starts it on first use and keeps it running for the session:

| Language | Language server | Install |
| --- | --- | --- |
| C# / .NET | csharp-ls | `dotnet tool install --global csharp-ls` |
| TypeScript / JavaScript | typescript-language-server | `npm install --global typescript-language-server typescript` |

Other languages use text matches only. Names on removed (red) lines also always use text matches, since those lines no longer exist in the files on disk.

#### Setting up exact results

You don't need to set anything up in advance. When you open a C# or TypeScript repository, diffloupe checks what exact navigation needs and shows a banner if something is missing. A chip next to the diff stats shows the current state, for example **C# · Setup needed**, **C# · Loading solution…** or **C# · Exact navigation**. Click it to open a setup checklist covering:

- **C#:** a .NET SDK new enough for csharp-ls and for your projects' target frameworks, any SDK pinned by `global.json`, csharp-ls itself, a solution or project file, and restored NuGet packages
- **TypeScript/JavaScript:** typescript-language-server, the `typescript` package, and installed dependencies

Each missing item shows the command to run. Steps that are safe to automate (installing the language server, `dotnet restore`, installing dependencies) have a **Run it for me** button; this only works when diffloupe listens on localhost, the default. Once everything is in place, diffloupe starts the language server in the background, so the project is loaded before your first click.

diffloupe looks for `csharp-ls` in `~/.dotnet/tools` and `typescript-language-server` in the repo's `node_modules/.bin`, as well as on your `PATH`. Large .NET solutions can take a while to load; until then the panel shows text matches and switches to exact results automatically.

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

## Development

Requires Node.js 20+ and pnpm (`corepack enable`).

```bash
pnpm install
pnpm dev:server    # API server on port 3433
pnpm dev:client    # Vite dev server for the UI, proxies /api to 3433
pnpm typecheck
pnpm build         # Builds the UI and CLI into dist/
```

To release, add a changeset with `pnpm changeset` and push to `main`. The release workflow opens a version PR; merging it publishes to npm.

## License

MIT. Based on [diffx](https://github.com/wong2/diffx) by wong2; see [LICENSE](LICENSE).
