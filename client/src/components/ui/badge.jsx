import * as React from 'react'
import { cva } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * shadcn's Badge plus the labels this catalogue actually needs.
 *
 * `overlay` is the important one: badges that sit on product photography need
 * their own dark backdrop, because a translucent tint over an unknown image is
 * a coin flip on legibility.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-pill border px-2.5 py-0.5 ' +
    'text-2xs font-bold uppercase tracking-wider transition-colors ' +
    'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        // ---- house ----------------------------------------------------
        deal: 'border-transparent bg-primary text-primary-foreground shadow-lg',
        overlay: 'border-transparent bg-black/65 text-white shadow-lg backdrop-blur-md',
        success: 'border-transparent bg-success/15 text-success',
        warning: 'border-transparent bg-warning/15 text-warning',
        info: 'border-transparent bg-info/15 text-info',
        muted: 'border-transparent bg-muted text-muted-foreground',
        // ---- stock shadcn ---------------------------------------------
        default: 'border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80',
        secondary: 'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive: 'border-transparent bg-destructive text-destructive-foreground shadow',
        outline: 'border-border text-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({ className, variant, ...props }) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

/** Stock status, mapped once so the three states read the same everywhere. */
function StockBadge({ status, className }) {
  const map = {
    in: ['In stock', 'success'],
    low: ['Low stock', 'warning'],
    out: ['Out of stock', 'destructive'],
    published: ['Live', 'success'],
    draft: ['Draft', 'muted'],
    new: ['New', 'deal'],
    open: ['In progress', 'info'],
    closed: ['Closed', 'muted'],
  }
  const [label, variant] = map[status] ?? [status, 'muted']
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  )
}

export { Badge, StockBadge, badgeVariants }
