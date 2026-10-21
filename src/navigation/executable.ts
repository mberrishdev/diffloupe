import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const IS_WINDOWS = process.platform === 'win32'
// On Windows a command is a file like csharp-ls.exe or npm.cmd. The file with
// no extension next to an npm .cmd shim is a shell script Windows can't run.
const EXTENSIONS = IS_WINDOWS
  ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((ext) => ext.toLowerCase())
  : ['']

export function findExecutable(command: string, extraDirs: string[] = []): string | null {
  const dirs = [...extraDirs, ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean)
  for (const dir of dirs) {
    for (const ext of EXTENSIONS) {
      const candidate = join(dir, command + ext)
      try {
        accessSync(candidate, constants.X_OK)
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // not here
      }
    }
  }
  return null
}

/**
 * How to spawn an executable from findExecutable. Windows only runs .cmd and
 * .bat files (npm's shims) through the shell, which needs the path quoted.
 */
export function spawnable(executable: string): { command: string; shell: boolean } {
  return IS_WINDOWS && /\.(cmd|bat)$/i.test(executable)
    ? { command: `"${executable}"`, shell: true }
    : { command: executable, shell: false }
}
