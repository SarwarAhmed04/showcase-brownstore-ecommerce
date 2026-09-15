import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'

import { cn } from '@/lib/utils'

/**
 * shadcn's Button, extended with the Brown Store house variants.
 *
 * The stock variants are kept intact so anything copied from shadcn or Origin
 * UI still works; `brand` and `glass` are the two this shop actually leans on.
 * Putting them here — rather than passing a wall of classNames at every call
 * site — is what keeps the buttons consistent across storefront and admin.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-semibold ' +
    'transition-all duration-300 select-none rounded-md text-sm ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ' +
    'disabled:pointer-events-none disabled:opacity-50 ' +
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // ---- house ----------------------------------------------------
        brand:
          'rounded-pill bg-gradient-to-br from-caramel-400 to-caramel-600 text-primary-foreground ' +
          'shadow-[0_10px_26px_-8px_rgb(var(--primary)/.55),inset_0_1px_0_rgb(255_255_255/.45)] ' +
          'hover:-translate-y-0.5 hover:shadow-[0_18px_36px_-10px_rgb(var(--primary)/.7),inset_0_1px_0_rgb(255_255_255/.55)] ' +
          'active:translate-y-0',
        glass:
          'rounded-pill border border-border/70 bg-foreground/[.06] text-foreground backdrop-blur-md ' +
          'hover:-translate-y-0.5 hover:bg-foreground/[.12]',
        // sits on top of product photography, so it carries its own backdrop
        // rather than trusting a translucent tint over an unknown image
        overlay:
          'rounded-pill bg-black/45 text-white backdrop-blur-md hover:scale-110 hover:bg-black/65',
        // ---- stock shadcn ---------------------------------------------
        default: 'bg-primary text-primary-foreground shadow hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90',
        outline: 'border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        quiet: 'text-muted-foreground hover:bg-accent hover:text-foreground',
      },
      size: {
        default: 'h-9 px-4 py-2',
        xs: 'h-7 rounded-md px-2.5 text-2xs',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-11 px-6 text-base',
        xl: 'h-[52px] px-8 text-base',
        icon: 'h-9 w-9',
        'icon-sm': 'h-8 w-8',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
})
Button.displayName = 'Button'

export { Button, buttonVariants }
