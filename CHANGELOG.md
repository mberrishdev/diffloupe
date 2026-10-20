# Changelog

## 0.0.2

### Patch Changes

- 5939ad6: Install fewer packages: UI-only libraries are now bundled into the web client instead of being installed as runtime dependencies. Declare Node.js 20 or newer as the supported runtime.
- 3bf0675: Explain code navigation in the README with a worked example, and expand the package description.

## 0.0.1

First release of diffloupe, forked from [diffx](https://github.com/wong2/diffx) 0.16.0. For changes before the fork, see the [diffx changelog](https://github.com/wong2/diffx/blob/main/CHANGELOG.md).

### Minor Changes

- Rename the project from diffx to diffloupe. Install with `npm install -g diffloupe` and run `diffloupe`. The agent skills are now `/diffloupe-start-review` and `/diffloupe-finish-review`. Settings and recent repos are copied from `~/.config/diffx` to `~/.config/diffloupe` on first run.
- Review multiple git repositories in one session. Click the repo name in the toolbar to switch repos, remove one, or add another; the picker suggests git worktrees, recently used repos and nearby repos (those with changes first), or takes any path. Running `diffloupe` outside a repository opens the picker, and repo paths can also be passed on the command line (`diffloupe ../api ../web`). Comments and viewed state are tracked per repo, and comments now include `repoId` and `repoPath`.
- Add code navigation: ⌘/Ctrl-click a symbol in the diff to see its definitions, implementations and references with a file preview. Results appear instantly from text search and are replaced by exact results from csharp-ls (C#) or typescript-language-server (TypeScript/JavaScript) when installed.
- Guide code navigation setup in the UI: when a C# or TypeScript repository is opened, diffloupe checks the .NET SDK, global.json, csharp-ls, solution files and NuGet restore (or typescript-language-server, TypeScript and dependencies), shows a banner listing what's missing, and offers a setup checklist with commands and one-click fixes. The language server is started in the background once everything is ready, and a toolbar chip shows its status.
