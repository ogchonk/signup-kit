/* Browser helper for any sign-up form, no framework. Posts JSON, maps the reply to the site's own
   words, writes them to an aria-live element, and blocks a double submit while one is in flight. */

export type FormMessages = {
  sending: string
  ok: string
  invalid: string
  busy: string
  unavailable: string
}

export type FormStatus = keyof FormMessages

export function statusFor(httpStatus: number | null): Exclude<FormStatus, "sending"> {
  if (httpStatus === 200) return "ok"
  if (httpStatus === 400 || httpStatus === 413 || httpStatus === 415) return "invalid"
  if (httpStatus === 429) return "busy"
  return "unavailable"
}

export type SubmitOptions = {
  endpoint: string
  email: string
  company?: string
  source?: string
  fetchImpl?: typeof fetch
}

export async function submitSignup(o: SubmitOptions): Promise<Exclude<FormStatus, "sending">> {
  try {
    const res = await (o.fetchImpl ?? fetch)(o.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: o.email, company: o.company ?? "", source: o.source }),
    })
    return statusFor(res.status)
  } catch {
    return statusFor(null)
  }
}

export type AttachOptions = {
  endpoint: string
  messages: FormMessages
  source?: string
  /** Element whose text shows the status; gets aria-live="polite". */
  status: HTMLElement
  onStatus?: (s: FormStatus) => void
}

/** Wires a <form> with an input[name=email] and an optional hidden input[name=company] honeypot. */
export function attachSignupForm(form: HTMLFormElement, o: AttachOptions): () => void {
  let busy = false
  o.status.setAttribute("aria-live", "polite")
  const show = (s: FormStatus) => {
    o.status.textContent = o.messages[s]
    o.onStatus?.(s)
  }
  const onSubmit = async (ev: Event) => {
    ev.preventDefault()
    if (busy) return
    busy = true
    const button = form.querySelector<HTMLButtonElement>("button[type=submit],button:not([type])")
    button?.setAttribute("aria-disabled", "true")
    show("sending")
    const email = (form.elements.namedItem("email") as HTMLInputElement | null)?.value ?? ""
    const company = (form.elements.namedItem("company") as HTMLInputElement | null)?.value ?? ""
    const s = await submitSignup({ endpoint: o.endpoint, email, company, source: o.source })
    show(s)
    if (s === "ok") form.reset()
    button?.removeAttribute("aria-disabled")
    busy = false
  }
  form.addEventListener("submit", onSubmit)
  return () => form.removeEventListener("submit", onSubmit)
}
