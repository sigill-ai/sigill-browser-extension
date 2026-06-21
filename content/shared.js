async function sigillStamp(platform, role, text, conversationId) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'STAMP', platform, role, text, conversationId });
    if (res?.ok) console.debug(`[Sigill] stamped ${platform} ${role} (${text.length} chars)`);
    else if (res?.skipped) console.debug('[Sigill] skipped — no API key or platform disabled');
    else if (res?.error) console.warn('[Sigill] stamp error:', res.error);
    return res;
  } catch {
    return null;
  }
}

function sigillInjectBadge(el) {
  if (el.querySelector('.sigill-stamp')) return;

  const a = document.createElement('a');
  a.href = 'https://sigill.ai';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = 'Timestamped by Sigill';
  a.style.cssText = [
    'display:inline-flex', 'align-items:center', 'gap:3px',
    'opacity:0.4', 'text-decoration:none', 'color:inherit',
    'transition:opacity 0.15s', 'cursor:pointer',
  ].join(';');
  a.addEventListener('mouseenter', () => { a.style.opacity = '0.85'; });
  a.addEventListener('mouseleave', () => { a.style.opacity = '0.4'; });
  a.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 3L4 7v5c0 5.25 3.4 10.15 8 11 4.6-.85 8-5.75 8-11V7l-8-4z" fill="#6366f1"/>
    <path d="M9 12l2 2 4-4" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  const wrapper = document.createElement('div');
  wrapper.className = 'sigill-stamp';
  wrapper.style.cssText = 'margin-top:5px;line-height:1;';
  wrapper.appendChild(a);
  el.appendChild(wrapper);
}
