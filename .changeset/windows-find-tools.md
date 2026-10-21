---
'diffloupe': patch
---

Find language servers and tools on Windows. diffloupe looked for files named exactly `csharp-ls`, `dotnet` or `npm`, but on Windows they are `csharp-ls.exe`, `dotnet.exe` and `npm.cmd`, so installed tools showed as missing. It now tries the Windows executable extensions, looks for .NET in `Program Files`, and runs npm's `.cmd` shims (such as `typescript-language-server.cmd`) through the shell as Windows requires.
