(async () => {
  const out = {};
  const btns = Array.from(document.querySelectorAll('button'));
  const shotBtn = btns.find((b) => (b.getAttribute('aria-label') || '') === '截图' || (b.title || '') === '截图');
  out.shotBtnFound = !!shotBtn;
  if (shotBtn) shotBtn.click();
  await new Promise((r) => setTimeout(r, 3000));
  out.pickerShown = !!document.querySelector('[data-dsh-capture-picker]');
  const kd = (k) => {
    try { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) } catch {}
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })) } catch {}
  };
  kd('Enter');
  await new Promise((r) => setTimeout(r, 2000));
  const ov = document.querySelector('[data-dsh-capture-annotate]');
  out.annotateShown = !!ov;
  out.annotateText = ov ? ov.textContent.slice(0, 160) : null;
  out.annotateToolbarButtons = ov ? Array.from(ov.querySelectorAll('button')).map((b) => b.textContent) : null;
  kd('Escape');
  await new Promise((r) => setTimeout(r, 500));
  out.afterEscapeGone = !document.querySelector('[data-dsh-capture-annotate]');
  return JSON.stringify(out, null, 2);
})()