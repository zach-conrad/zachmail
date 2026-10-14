import { expect, test, type Page } from '@playwright/test'

// Budgets from architecture §1a. Interaction times are input event → UI committed, measured
// in the page by src/lib/perf.ts.
const BUDGET = {
  coldStart: 1000,
  keyAction: 16,
  openPrefetched: 50,
  palette: 16,
  searchKey: 50,
  droppedFrames: 0.05,
}

test.describe.configure({ mode: 'serial' })

let page: Page
const report: Record<string, unknown> = {}

const samples = (name: string) =>
  page.evaluate((n) => window.__zmPerf?.samples[n]?.slice() ?? [], name)
const clearSamples = () =>
  page.evaluate(() => {
    const s = window.__zmPerf!.samples
    for (const k of Object.keys(s)) delete s[k]
  })
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN
}
const summary = (xs: number[]) => ({
  n: xs.length,
  p50: +pct(xs, 50).toFixed(2),
  p95: +pct(xs, 95).toFixed(2),
  max: +Math.max(...xs).toFixed(2),
})

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage()
  // Third-party fonts are not part of the budget and vary with the network; keep runs stable.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort())
  await page.goto('/?demo=20000')
  // First visit seeds the local replica with the 20k-thread fixture.
  await page.waitForFunction(() => window.__zmPerf?.marks.synced !== undefined, null, {
    timeout: 90_000,
  })
})

test.afterAll(() => {
  console.log('\nperf results\n' + JSON.stringify(report, null, 2))
})

test('cold start to usable inbox (cached) < 1 s', async () => {
  await page.reload()
  await page.waitForFunction(() => window.__zmPerf?.marks['inbox-ready'] !== undefined)
  const ms = await page.evaluate(() => window.__zmPerf!.marks['inbox-ready']!)
  report.coldStartMs = +ms.toFixed(1)
  expect(ms).toBeLessThan(BUDGET.coldStart)
  await page.waitForFunction(() => window.__zmPerf?.marks.synced !== undefined)
})

test('j/k through 100 threads: each key < 16 ms', async () => {
  await clearSamples()
  for (let i = 0; i < 100; i++) await page.keyboard.press('j')
  for (let i = 0; i < 100; i++) await page.keyboard.press('k')
  const xs = [...(await samples('nav.next')), ...(await samples('nav.prev'))]
  report.jk = summary(xs)
  expect(xs.length).toBe(200)
  expect(pct(xs, 95)).toBeLessThan(BUDGET.keyAction)
})

test('open a prefetched thread < 50 ms', async () => {
  const xs: number[] = []
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('j')
    // Prefetch of the focused thread's details and bodies settles while the user reads.
    await page.waitForTimeout(150)
    await clearSamples()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => (window.__zmPerf?.samples['nav.open']?.length ?? 0) > 0)
    xs.push(...(await samples('nav.open')))
    await page.keyboard.press('Escape')
  }
  report.openPrefetched = { ...summary(xs), all: xs.map((x) => +x.toFixed(1)) }
  expect(pct(xs, 95)).toBeLessThan(BUDGET.openPrefetched)
})

test('command palette opens < 16 ms', async () => {
  const xs: number[] = []
  for (let i = 0; i < 10; i++) {
    await clearSamples()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    xs.push(...(await samples('app.palette')))
    await page.keyboard.press('Escape')
  }
  report.palette = summary(xs)
  expect(pct(xs, 95)).toBeLessThan(BUDGET.palette)
})

test('search as you type: results per keystroke < 50 ms', async () => {
  const xs: number[] = []
  for (const query of ['design review', 'from:ana plan', 'is:unread contract']) {
    await page.keyboard.press('/')
    const input = page.getByRole('textbox', { name: 'Search mail' })
    await expect(input).toBeFocused()
    await clearSamples()
    for (const ch of query) {
      await page.keyboard.type(ch)
      // Let each keystroke's results land before the next, as a typist's pace allows.
      await page.waitForTimeout(60)
    }
    xs.push(...(await samples('search.type')))
    await expect(page.locator('.thread-list .row[id]').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(input).toBeHidden()
  }
  report.search = summary(xs)
  expect(xs.length).toBeGreaterThan(20)
  expect(pct(xs, 95)).toBeLessThan(BUDGET.searchKey)
})

test('archive 50 threads, then undo: each key < 16 ms', async () => {
  const count = () =>
    page.evaluate(() => document.querySelectorAll('.thread-list .row[id]').length > 0)
  expect(await count()).toBe(true)
  const first = () => page.locator('.row[data-focused]').getAttribute('id')
  await clearSamples()
  const archived: (string | null)[] = []
  for (let i = 0; i < 50; i++) {
    archived.push(await first())
    await page.keyboard.press('e')
  }
  await expect(page.locator('.toast')).toContainText('Done')
  const done = await samples('thread.done')
  // Undo the last five; each archived row comes back focused, in place.
  for (let i = 0; i < 5; i++) await page.keyboard.press('z')
  expect(await first()).toBe(archived[45])
  const undo = await samples('undo')
  report.archive = summary(done)
  report.undo = summary(undo)
  expect(done.length).toBe(50)
  expect(undo.length).toBe(5)
  expect(new Set(archived).size).toBe(50)
  expect(pct(done, 95)).toBeLessThan(BUDGET.keyAction)
  expect(pct(undo, 95)).toBeLessThan(BUDGET.keyAction)
})

test('scrolling thousands of threads holds 60 fps', async () => {
  const frames = await page.evaluate(async () => {
    const list = document.querySelector<HTMLElement>('.thread-list')!
    const deltas: number[] = []
    let last = performance.now()
    const end = last + 3000
    await new Promise<void>((done) => {
      const step = (t: number) => {
        deltas.push(t - last)
        last = t
        list.scrollTop += list.clientHeight / 2
        if (t < end) requestAnimationFrame(step)
        else done()
      }
      requestAnimationFrame(step)
    })
    return { deltas: deltas.slice(1), rows: list.scrollHeight / 40 }
  })
  const dropped = frames.deltas.filter((d) => d > 1000 / 60 + 8).length / frames.deltas.length
  report.scroll = {
    rows: frames.rows,
    ...summary(frames.deltas),
    droppedFraction: +dropped.toFixed(3),
  }
  expect(frames.rows).toBeGreaterThan(5000)
  expect(dropped).toBeLessThan(BUDGET.droppedFrames)
})
