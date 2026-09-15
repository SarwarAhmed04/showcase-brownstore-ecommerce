// Explicit icon map for category tiles.
//
// `import * as Icons from 'lucide-react'` would work, but it defeats
// tree-shaking and drags the entire icon set into the bundle — it cost ~650 KB
// here. Naming the handful we actually use keeps the build lean.
import {
  Baby, CookingPot, Flower2, Home, Laptop, Package, Refrigerator, ShieldCheck,
  Shirt, Sparkles, Wrench,
} from 'lucide-react'

const MAP = {
  Baby, CookingPot, Flower2, Home, Laptop, Refrigerator, ShieldCheck, Shirt,
  Sparkles, Wrench,
}

/** Resolve a category's icon name to its component (for passing as a prop). */
export const categoryIcon = (name) => MAP[name] ?? Package

/** Render a category icon directly. */
export function CategoryIcon({ name, ...props }) {
  const Icon = categoryIcon(name)
  return <Icon {...props} />
}
