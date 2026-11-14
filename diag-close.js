(async () => {
  const out = {};
  const row = document.querySelector('button[aria-label="虚拟桌面"]');
  if (!row) return JSON.stringify({ err: 'no row' });
  if (!document.querySelector('.dsh-vdesk-pop')) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  await new Promise((r) => setTimeout(r, 700));
  const pop = document.querySelector('.dsh-vdesk-pop');
  const meta = pop ? pop.querySelector('.meta') : null;
  out.metaBefore = meta ? meta.textContent : null;
  const btns = pop ? Array.from(pop.querySelectorAll('button')) : [];
  out.buttonsBefore = btns.map((b) => ({ t: b.textContent, disabled: b.disabled }));
  const close = btns.find((b) => b.textContent === '关闭' || b.textContent === '关闭中…');
  out.closeFound = !!close;
  if (close && !close.disabled) { close.click(); out.clickedClose = true; } else { out.clickedClose = false; }
  await new Promise((r) => setTimeout(r, 4000));
  const pop2 = document.querySelector('.dsh-vdesk-pop');
  const meta2 = pop2 ? pop2.querySelector('.meta') : null;
  out.metaAfter = meta2 ? meta2.textContent : null;
  out.buttonsAfter = pop2 ? Array.from(pop2.querySelectorAll('button')).map((b) => ({ t: b.textContent, disabled: b.disabled })) : null;
  return JSON.stringify(out, null, 2);
})()