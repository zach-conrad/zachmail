const today = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

export function InboxZero({ hero }: { hero: boolean }) {
  return (
    <section className={hero ? 'zero zero-hero' : 'zero'} aria-live="polite">
      <h1 className="display">You&rsquo;re all done.</h1>
      <p className="muted">{today.format(new Date())}</p>
    </section>
  )
}
