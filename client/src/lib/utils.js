import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge class names, letting later Tailwind utilities win over earlier ones.
 *
 * Plain string concatenation leaves both `p-4` and `p-6` in the class list and
 * the winner is whichever CSS rule happens to come last in the stylesheet —
 * which is why overriding a component's padding from a prop so often does
 * nothing. twMerge resolves those conflicts by specificity of intent instead.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
