// Fonts load after first paint so they never block rendering; system fonts show until then.
export function loadFonts() {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href =
    'https://fonts.googleapis.com/css2?family=Geist:wght@400..600&family=Newsreader:opsz@6..72&display=swap'
  document.head.append(link)
}
