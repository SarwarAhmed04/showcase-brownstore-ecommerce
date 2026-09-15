import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { Check, Loader2, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { api } from '../api'
import { imgUrl } from '../lib/img'
import { useLang } from '../context/LangContext'

export default function EnquiryDialog({ product, trigger, defaultSubject }) {
  const { t } = useLang()
  const subjects = [t.subjectReserve, t.subjectStock, t.subjectQuestion, t.subjectWarranty]
  const initialSubject = defaultSubject || t.subjectReserve
  const [open, setOpen] = useState(false)
  const [sent, setSent] = useState(false)
  const [subject, setSubject] = useState(initialSubject)

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    defaultValues: { name: '', email: '', message: '' },
  })

  const onSubmit = async (values) => {
    try {
      await api.createEnquiry({
        ...values,
        subject,
        productId: product?.id ?? null,
        productName: product?.name ?? '',
      })
      setSent(true)
      toast.success(t.toastEnquiry)
    } catch (err) {
      if (err.details?.length) {
        err.details.forEach((d) => setError(d.field, { message: d.message }))
        toast.error(t.toastFields)
      } else {
        toast.error(err.message || t.toastSendFail)
      }
    }
  }

  const close = (next) => {
    setOpen(next)
    if (!next) {
      setTimeout(() => {
        setSent(false)
        reset()
        setSubject(initialSubject)
      }, 200)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>

      <DialogContent className="glass rounded-panel border-0 sm:max-w-lg">
        {sent ? (
          <div className="flex flex-col items-center py-10 text-center">
            <span className="mb-5 grid size-14 place-items-center rounded-pill bg-success/15 text-success">
              <Check className="size-7" />
            </span>
            <DialogTitle className="headline text-xl">{t.messageSent}</DialogTitle>
            <DialogDescription className="mt-2 max-w-sm text-xs">
              {product ? t.enquiryHold : t.enquiryReply}
            </DialogDescription>
            <Button variant="glass" className="mt-7" onClick={() => close(false)}>
              {t.close}
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="headline text-xl">
                {product ? t.reserveOrAsk : t.sendUsMessage}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {t.enquiryHint}
              </DialogDescription>
            </DialogHeader>

            {product && (
              <div className="glass-soft flex items-center gap-3 rounded-md p-3">
                <img
                  src={imgUrl(product.img, { w: 96, h: 96 })}
                  alt=""
                  className="size-12 shrink-0 rounded-md object-cover"
                />
                <div className="min-w-0 flex-1">
                  <div className="clamp-1 text-xs font-semibold">{product.name}</div>
                  <div className="text-2xs text-muted-foreground">{product.brand}</div>
                </div>
              </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t.yourName} error={errors.name?.message}>
                  <Input
                    {...register('name', {
                      required: t.nameRequired,
                      minLength: { value: 2, message: t.nameRequired },
                    })}
                    placeholder={t.enquiryNamePh}
                    aria-invalid={Boolean(errors.name)}
                  />
                </Field>
                <Field label={t.email} error={errors.email?.message}>
                  <Input
                    type="email"
                    {...register('email', {
                      required: t.emailRequired,
                      pattern: { value: /^\S+@\S+\.\S+$/, message: t.emailInvalid },
                    })}
                    placeholder="you@example.com"
                    aria-invalid={Boolean(errors.email)}
                  />
                </Field>
              </div>

              <div>
                <span className="mb-2 block text-2xs font-bold uppercase tracking-[.14em] text-muted-foreground">
                  {t.whatAbout}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {subjects.map((s) => (
                    <Button
                      key={s}
                      type="button"
                      size="xs"
                      variant={subject === s ? 'brand' : 'glass'}
                      onClick={() => setSubject(s)}
                      aria-pressed={subject === s}
                    >
                      {s}
                    </Button>
                  ))}
                </div>
              </div>

              <Field label={t.description} error={errors.message?.message}>
                <Textarea
                  rows={4}
                  {...register('message', {
                    required: t.messageRequired,
                    minLength: { value: 5, message: t.messageRequired },
                  })}
                  placeholder={product ? t.enquiryMsgPh : t.enquiryMsgGeneric}
                  aria-invalid={Boolean(errors.message)}
                />
              </Field>

              <Button type="submit" variant="brand" size="lg" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? <Loader2 className="animate-spin" /> : <Send />}
                {product ? t.sendReservation : t.sendEnquiry}
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Field({ label, error, children }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-2xs font-bold uppercase tracking-[.14em] text-muted-foreground">
        {label}
      </Label>
      {children}
      {error && <p className="text-2xs text-destructive">{error}</p>}
    </div>
  )
}
