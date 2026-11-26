// Applies the stored theme before first paint, so a page opened in the other theme does not
// flash. The design system reads data-theme on the root; without it the theme follows the
// system setting. Built as a file of its own (vite.config.ts, themeScript) and loaded in the
// head without `defer`: the page's content security policy allows no inline script.
try {
  var t = localStorage.getItem('viz.theme')
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
} catch (e) {}
