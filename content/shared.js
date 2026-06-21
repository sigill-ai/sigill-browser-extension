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

function sigillInjectBadge(el, role) {
  if (el.dataset.sigillDone) return;
  el.dataset.sigillDone = '1';

  const a = document.createElement('a');
  a.href = 'https://sigill.ai';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.title = 'Timestamped by Sigill';
  a.className = 'sigill-stamp';
  a.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;opacity:0.45;text-decoration:none;transition:opacity 0.15s;flex-shrink:0;';
  a.addEventListener('mouseenter', () => { a.style.opacity = '1'; });
  a.addEventListener('mouseleave', () => { a.style.opacity = '0.45'; });
  a.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 3L4 7v5c0 5.25 3.4 10.15 8 11 4.6-.85 8-5.75 8-11V7l-8-4z" fill="#6366f1"/>
    <path d="M9 12l2 2 4-4" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  // Walk up from el to find a container, then look for the buttons row
  // (the row with copy/thumbs/share action buttons — 2+ direct <button> children)
  const container = el.closest('article') || el.parentElement;
  let buttonsRow = null;
  if (container) {
    for (const div of container.querySelectorAll('div')) {
      if (div.querySelectorAll(':scope > button').length >= 2) {
        buttonsRow = div;
        break;
      }
    }
  }

  if (buttonsRow) {
    buttonsRow.appendChild(a);
  } else {
    // Fallback: small badge below the message, aligned to match user/assistant side
    const wrapper = document.createElement('div');
    wrapper.className = 'sigill-stamp';
    wrapper.style.cssText = `margin-top:5px;display:flex;align-items:center;justify-content:${role === 'user' ? 'flex-end' : 'flex-start'};`;
    wrapper.appendChild(a);
    el.appendChild(wrapper);
  }
}
