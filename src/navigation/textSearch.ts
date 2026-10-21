import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { clipLine, SYMBOL_PATTERN } from './types.js'
import type { NavLocation, NavResult } from './types.js'

const execFileAsync = promisify(execFile)

const MAX_MATCHES = 2000

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Declaration keywords and modifiers across C#, Java, TypeScript/JavaScript,
// Python, Go, Rust and friends. Heuristic by design: this is the instant,
// language-agnostic answer that a language server later refines.
const TYPE_KEYWORDS = 'class|interface|struct|enum|record|type|trait|namespace|module|delegate|object'
const FUNCTION_KEYWORDS = 'function\\*?|def|func|fn|sub|macro'
const MODIFIERS =
  'public|private|protected|internal|static|readonly|async|override|virtual|abstract|sealed|extern|partial|export|default|declare|unsafe|new|final|const|required'

function classifiers(symbol: string) {
  const id = escapeRegExp(symbol)
  const definition = [
    new RegExp(`\\b(?:${TYPE_KEYWORDS})\\s+${id}\\b`),
    new RegExp(`\\b(?:${FUNCTION_KEYWORDS})\\s+${id}\\b`),
    new RegExp(`\\b(?:const|let|var|val)\\s+${id}\\s*[=:]`),
    // Members declared with modifiers: `public async Task<User> GetUser(`,
    // `private readonly IFoo _foo;`, `public string Name { get; set; }`.
    new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:(?:${MODIFIERS})\\s+)+[^=;(]*?\\b${id}\\s*(?:<[^>]*>)?\\s*(?:\\(|\\{|=>|=|;|:)`),
    // Modifier-less typed members, e.g. interface methods and default-private
    // C# methods: `decimal Total(int id);`, `void Run() {`. Statement keywords
    // are excluded so calls like `return Total(id);` stay references.
    new RegExp(`^\\s*(?!(?:return|await|new|throw|yield|else|case|goto|in|is|as|out|ref)\\b)[\\w<>\\[\\],.?]+\\s+${id}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?:;|\\{|=>)`),
    // Modifier-less methods in JS/TS classes and object literals: `foo(a, b) {`.
    new RegExp(`^\\s*(?:async\\s+|get\\s+|set\\s+|\\*\\s*)?${id}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^{=]+)?\\{\\s*$`),
  ]
  // Types that implement or extend the symbol: `class UserService : IUserService`,
  // `class Foo extends Bar implements IBaz`.
  const implementation = new RegExp(`\\b(?:class|struct|record)\\s+\\w+[^{;]*(?::|\\bextends\\b|\\bimplements\\b)[^{;]*\\b${id}\\b`)
  // Column of the whole-word occurrence, in UTF-16 units like the browser.
  const occurrence = new RegExp(`(?<![\\w$])${id}(?![\\w$])`)
  return { definition, implementation, occurrence }
}

/**
 * Finds a symbol's definitions, implementations and references with
 * `git grep` over the work tree (tracked and untracked, ignoring
 * .gitignored files). Matches are whole-word and classified by pattern.
 */
export async function textSearch(root: string, symbol: string): Promise<NavResult> {
  const empty: NavResult = { symbol, definitions: [], implementations: [], references: [], truncated: false }
  if (!SYMBOL_PATTERN.test(symbol)) return empty

  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(
      'git',
      ['grep', '-n', '-z', '-I', '-w', '-F', '--untracked', '-e', symbol],
      { cwd: root, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
    ))
  } catch (err) {
    // git grep exits 1 when nothing matches.
    if ((err as { code?: number }).code === 1) return empty
    throw err
  }

  const { definition, implementation, occurrence } = classifiers(symbol)
  const [typeDefinition, ...otherDefinitions] = definition
  const result = { ...empty }
  const lines = stdout.split('\n')
  for (const raw of lines) {
    if (!raw) continue
    if (result.definitions.length + result.implementations.length + result.references.length >= MAX_MATCHES) {
      result.truncated = true
      break
    }
    const [path, lineStr, ...rest] = raw.split('\0')
    const text = rest.join('\0')
    const location: NavLocation = {
      path,
      line: Number(lineStr),
      column: Math.max(0, text.search(occurrence)),
      text: clipLine(text),
    }
    // A type's own declaration wins over the implementation check, so
    // `class Foo : Base<Foo>` counts as Foo's definition.
    if (typeDefinition.test(text)) result.definitions.push(location)
    else if (implementation.test(text)) result.implementations.push(location)
    else if (otherDefinitions.some((re) => re.test(text))) result.definitions.push(location)
    else result.references.push(location)
  }
  return result
}
