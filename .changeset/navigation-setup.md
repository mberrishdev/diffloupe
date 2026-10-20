---
'diffloupe': minor
---

Guide code navigation setup in the UI: when a C# or TypeScript repository is opened, diffloupe checks the .NET SDK, global.json, csharp-ls, solution files and NuGet restore (or typescript-language-server, TypeScript and dependencies), shows a banner listing what's missing, and offers a setup checklist with commands and one-click fixes. The language server is started in the background once everything is ready, and a toolbar chip shows its status.
