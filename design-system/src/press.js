/* viz press state. A press is painted in the first frame after the input event, for every pointer (project/README.md, "States" and the
   first budget row). CSS :active alone does not do that for a finger: Chromium applies it to a touch at the release, or after a delay, and
   not while the finger is held (v5 review, M3: "never" while a finger was down). This sets data-pressed, the same state as :active in
   components.css, on the pressed control and its ancestors from pointerdown until the press ends. It changes no layout and starts no work.
   Load it once per page, after the stylesheet: <script src="viz-press.js" defer></script>. */
(() => {
  if (window.vzPress) return
  window.vzPress = true
  const PRESSABLE = 'button, a[href], summary, [role^="menuitem"], [role="tab"], label.vz-check, .vz-sort, tr[data-key]'
  let held = []
  const release = () => { for (const el of held) el.removeAttribute('data-pressed'); held = [] }
  addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button > 0) return
    release()
    const el = e.target instanceof Element ? e.target.closest(PRESSABLE) : null
    if (!el || el.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]')) return
    // :active matches the element and every ancestor; so does data-pressed, so a row that shows its pressed fill when its button is held does here too
    for (let x = el; x && x !== document.documentElement; x = x.parentElement) { x.setAttribute('data-pressed', ''); held.push(x) }
  }, { capture: true, passive: true })
  for (const type of ['pointerup', 'pointercancel', 'dragstart', 'blur']) addEventListener(type, release, { capture: true, passive: true })
})()
