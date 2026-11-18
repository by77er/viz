// Injected into index.html by e2e/vite.shots.config.ts (never in a normal build).
// design-system/tools/shots.mjs can only open a URL, so states that need a click are
// requested with a hash: #shot=timepicker | palette | settings. The script waits for the
// view to settle, then operates the real controls.
;(function () {
  var m = /shot=([a-z-]+)/.exec(location.hash)
  if (!m) return
  var want = m[1]
  var byText = function (t) {
    return Array.prototype.find.call(document.querySelectorAll('button'), function (b) {
      return b.getAttribute('aria-label') === t || b.textContent.trim() === t
    })
  }
  var ready = function () {
    return document.querySelector('[data-testid=legend] tbody tr') || document.querySelector('[data-testid=start-state]')
  }
  var tries = 0
  var timer = setInterval(function () {
    if (++tries > 200) return clearInterval(timer)
    if (!ready()) return
    clearInterval(timer)
    if (want === 'timepicker') document.querySelector('[data-testid=time-range]').click()
    else if (want === 'palette') window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
    else if (want === 'settings') byText('Settings').click()
  }, 50)
})()
