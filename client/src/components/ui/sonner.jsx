import { Toaster as Sonner } from 'sonner'
import { useStore } from '@/store'

/**
 * shadcn ships this wired to `next-themes`, which is a Next.js package — there
 * is no Next.js here. It reads the theme from the Brown Store context instead,
 * and is styled with the same tokens as every other surface so toasts look
 * like they belong to the shop rather than to a component library.
 */
const Toaster = ({ ...props }) => {
  const { theme } = useStore()

  return (
    <Sonner
      theme={theme === 'cream' ? 'light' : 'dark'}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-card group-[.toaster]:text-card-foreground ' +
            'group-[.toaster]:border-border group-[.toaster]:shadow-2xl group-[.toaster]:rounded-card ' +
            'group-[.toaster]:backdrop-blur-xl',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          error: 'group-[.toaster]:text-destructive',
          success: 'group-[.toaster]:text-success',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
