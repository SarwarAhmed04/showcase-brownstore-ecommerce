import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { Check, Clock, Loader2, Mail, MapPin, Phone, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import PageHead from '../components/PageHead'
import { Reveal } from '../components/ui'
import { api } from '../api'
import { useLang } from '../context/LangContext'

const SUBJECT_KEYS = ['subjectQuestion', 'subjectStock', 'subjectWarranty', 'subjectOther']

export default function Contact() {
  const { t } = useLang()
  const [sent, setSent] = useState(false)
  const subjects = SUBJECT_KEYS.map((key) => t[key])
  const [subject, setSubject] = useState(subjects[0])

  useEffect(() => {
    setSubject(subjects[0])
  }, [t.subjectQuestion])

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({ defaultValues: { name: '', email: '', message: '' } })

  const lines = [
    { Icon: MapPin, title: t.showroom, body: t.showroomAddress, sub: t.collectionShowroom },
    { Icon: Phone, title: t.phone, body: '+964 751 760 7671', sub: t.hoursDaily, dir: 'ltr' },
    { Icon: Mail, title: t.email, body: 'info@brownstore.net', sub: t.emailReplyDay },
    { Icon: Clock, title: t.hours, body: '10:00 – 22:00', sub: t.hoursSevenDays },
  ]

  const onSubmit = async (values) => {
    try {
      await api.createEnquiry({ ...values, subject })
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

  return (
    <div className="container-x py-10 lg:py-section-sm">
      <PageHead
        eyebrow={t.contactEyebrow}
        title={
          <>
            {t.contactAskUs} <span className="gold-text">{t.contactAskGold}</span>
          </>
        }
        sub={t.contactSub}
        crumbs={[{ label: t.contact }]}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.15fr]">
        <div className="space-y-4">
          {lines.map((l, i) => (
            <Reveal key={l.title} delay={i * 70}>
              <Card className="glass flex gap-4 rounded-card border-0 p-6">
                <span className="grid size-11 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
                  <l.Icon className="size-5" />
                </span>
                <div>
                  <div className="text-2xs font-bold uppercase tracking-[.18em] text-muted-foreground">
                    {l.title}
                  </div>
                  <div className="mt-1 font-semibold" dir={l.dir}>{l.body}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{l.sub}</div>
                </div>
              </Card>
            </Reveal>
          ))}
        </div>

        <Reveal delay={120}>
          <Card className="glass rounded-panel border-0 p-7 sm:p-10">
            {sent ? (
              <div className="flex flex-col items-center py-16 text-center">
                <span className="mb-6 grid size-16 place-items-center rounded-pill bg-success/15 text-success">
                  <Check className="size-8" />
                </span>
                <h2 className="headline text-xl">{t.messageReceived}</h2>
                <p className="mt-2.5 max-w-sm text-xs text-muted-foreground">{t.messageReceivedBody}</p>
                <Button
                  variant="glass"
                  className="mt-7"
                  onClick={() => {
                    setSent(false)
                    reset()
                  }}
                >
                  {t.writeAnother}
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
                <div className="grid gap-5 sm:grid-cols-2">
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
                        pattern: {
                          value: /^\S+@\S+\.\S+$/,
                          message: t.emailInvalid,
                        },
                      })}
                      placeholder="you@example.com"
                      aria-invalid={Boolean(errors.email)}
                    />
                  </Field>
                </div>

                <div>
                  <span className="mb-2.5 block text-2xs font-bold uppercase tracking-[.16em] text-muted-foreground">
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

                <Field label={t.message} error={errors.message?.message}>
                  <Textarea
                    rows={6}
                    {...register('message', {
                      required: t.messageRequired,
                      minLength: { value: 5, message: t.messageRequired },
                    })}
                    placeholder={t.enquiryMsgGeneric}
                    aria-invalid={Boolean(errors.message)}
                  />
                </Field>

                <Button type="submit" variant="brand" size="lg" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 className="animate-spin" /> : <Send />}
                  {t.sendEnquiry}
                </Button>

                <p className="text-center text-2xs text-muted-foreground">{t.contactFormNote}</p>
              </form>
            )}
          </Card>
        </Reveal>
      </div>
    </div>
  )
}

function Field({ label, error, children }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-2xs font-bold uppercase tracking-[.16em] text-muted-foreground">
        {label}
      </Label>
      {children}
      {error && <p className="text-2xs text-destructive">{error}</p>}
    </div>
  )
}
