import { Toaster as Sonner } from 'sonner'

const Toaster = ({ ...props }) => (
  <Sonner
    theme="light"
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

export { Toaster }
