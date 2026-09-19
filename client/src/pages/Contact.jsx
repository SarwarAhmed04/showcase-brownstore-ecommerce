import { useState } from 'react'
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

const LINES = [
  { Icon: MapPin, title: 'Showroom', body: 'Karrada, Baghdad', sub: 'Collection at the showroom' },
  { Icon: Phone, title: 'Phone', body: '+964 773 802 9000', sub: 'Daily 10:00 – 22:00' },
  { Icon: Mail, title: 'Email', body: 'info@brownstore.com', sub: 'We reply within one working day' },
  { Icon: Clock, title: 'Opening hours', body: '10:00 – 22:00', sub: 'Seven days, Fridays included' },
]

const SUBJECTS = ['A product question', 'Stock & availability', 'Warranty or repair', 'Something else']

export default function Contact() {
  const [sent, setSent] = useState(false)
  const [subject, setSubject] = useState(SUBJECTS[0])

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({ defaultValues: { name: '', email: '', message: '' } })

  // This posts for real — it lands in the admin inbox at /admin/enquiries.
  const onSubmit = async (values) => {
    try {
      await api.createEnquiry({ ...values, subject })
      setSent(true)
      toast.success('Message sent — we will reply within a working day.')
    } catch (err) {
      if (err.details?.length) {
        err.details.forEach((d) => setError(d.field, { message: d.message }))
        toast.error('Check the highlighted fields.')
      } else {
        toast.error(err.message || 'Could not send that just now.')
      }
    }
  }

  return (
    <div className="container-x py-10 lg:py-section-sm">
      <PageHead
        eyebrow="Say hello"
        title={<>Ask us <span className="gold-text">anything</span></>}
        sub="A real person on the floor reads these. If you are asking whether something is in stock, mention the model and we will check while you wait."
        crumbs={[{ label: 'Contact' }]}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.15fr]">
        {/* ---------------- details ---------------- */}
        <div className="space-y-4">
          {LINES.map((l, i) => (
            <Reveal key={l.title} delay={i * 70}>
              <Card className="glass flex gap-4 rounded-card border-0 p-6">
                <span className="grid size-11 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
                  <l.Icon className="size-5" />
                </span>
                <div>
                  <div className="text-2xs font-bold uppercase tracking-[.18em] text-muted-foreground">
                    {l.title}
                  </div>
                  <div className="mt-1 font-semibold">{l.body}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{l.sub}</div>
                </div>
              </Card>
            </Reveal>
          ))}
        </div>

        {/* ---------------- form ---------------- */}
        <Reveal delay={120}>
          <Card className="glass rounded-panel border-0 p-7 sm:p-10">
            {sent ? (
              <div className="flex flex-col items-center py-16 text-center">
                <span className="mb-6 grid size-16 place-items-center rounded-pill bg-success/15 text-success">
                  <Check className="size-8" />
                </span>
                <h2 className="headline text-xl">Message received</h2>
                <p className="mt-2.5 max-w-sm text-xs text-muted-foreground">
                  It is now in the shop&rsquo;s inbox. Someone on the floor will get back to you
                  within a working day.
                </p>
                <Button
                  variant="glass"
                  className="mt-7"
                  onClick={() => {
                    setSent(false)
                    reset()
                  }}
                >
                  Write another
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Your name" error={errors.name?.message}>
                    <Input
                      {...register('name', {
                        required: 'Tell us your name.',
                        minLength: { value: 2, message: 'Tell us your name.' },
                      })}
                      placeholder="Rana Kadhim"
                      aria-invalid={Boolean(errors.name)}
                    />
                  </Field>
                  <Field label="Email" error={errors.email?.message}>
                    <Input
                      type="email"
                      {...register('email', {
                        required: 'We need somewhere to reply.',
                        pattern: {
                          value: /^\S+@\S+\.\S+$/,
                          message: 'That address does not look right.',
                        },
                      })}
                      placeholder="you@example.com"
                      aria-invalid={Boolean(errors.email)}
                    />
                  </Field>
                </div>

                <div>
                  <span className="mb-2.5 block text-2xs font-bold uppercase tracking-[.16em] text-muted-foreground">
                    What is it about?
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {SUBJECTS.map((s) => (
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

                <Field label="Message" error={errors.message?.message}>
                  <Textarea
                    rows={6}
                    {...register('message', {
                      required: 'Add a little more detail.',
                      minLength: { value: 5, message: 'Add a little more detail.' },
                    })}
                    placeholder="Tell us what you are looking for…"
                    aria-invalid={Boolean(errors.message)}
                  />
                </Field>

                <Button type="submit" variant="brand" size="lg" className="w-full" disabled={isSubmitting}>
                  {isSubmitting ? <Loader2 className="animate-spin" /> : <Send />}
                  Send message
                </Button>

                <p className="text-center text-2xs text-muted-foreground">
                  Nothing is sold through this site — messages reach the showroom, not a checkout.
                </p>
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
