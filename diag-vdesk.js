(async () => {
  const row = document.querySelector('button[aria-label="虚拟桌面"]');
  const before = document.querySelectorAll('.dsh-vdesk-pop').length;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  await new Promise((r) => setTimeout(r, 700));
  const after = document.querySelectorAll('.dsh-vdesk-pop').length;
  const pop = document.querySelector('.dsh-vdesk-pop');
  const allAria = Array.from(document.querySelectorAll('button[aria-label]')).map((b) => b.getAttribute('aria-label'));
  return JSON.stringify({
    href: location.href,
    styleTagInjected: !!document.querySelector('style[data-plugin="@local/dsh-vdesk"]'),
    rowFound: !!row,
    rowClass: row ? row.className : null,
    popsBefore: before,
    popsAfterClick: after,
    popRect: pop ? pop.getBoundingClientRect().toJSON() : null,
    popText: pop ? pop.textContent : null,
    allAriaLabels: allAria,
    errors: errors
  }, null, 2);
})()