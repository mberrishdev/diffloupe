import type { TokenEventBase } from '@pierre/diffs'
import { symbolFromToken } from './hooks/useNavigation'

/** Cmd-click on macOS, Ctrl-click elsewhere, like "Go to Definition" in VS Code. */
export const isNavigationClick = (event: MouseEvent | PointerEvent) => event.metaKey || event.ctrlKey

export const NAVIGATION_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘-click' : 'Ctrl+click'

/**
 * Token event handlers for @pierre/diffs that turn a modifier-click on an
 * identifier into a navigation request, and underline it on modifier-hover.
 */
export function tokenNavigationHandlers<P extends TokenEventBase>(
  onNavigate: (props: P, symbol: string, column: number) => void,
) {
  return {
    onTokenClick(props: P, event: MouseEvent) {
      if (!isNavigationClick(event)) return
      const target = symbolFromToken(props.tokenText, props.lineCharStart)
      if (!target) return
      event.preventDefault()
      onNavigate(props, target.symbol, target.column)
    },
    onTokenEnter(props: P, event: PointerEvent) {
      if (!isNavigationClick(event) || !symbolFromToken(props.tokenText, props.lineCharStart)) return
      // Tokens live in the renderer's shadow DOM, out of reach of page CSS.
      props.tokenElement.style.textDecoration = 'underline'
      props.tokenElement.style.cursor = 'pointer'
    },
    onTokenLeave(props: P) {
      props.tokenElement.style.textDecoration = ''
      props.tokenElement.style.cursor = ''
    },
  }
}
