// pay-logic.js — хостится на Vercel, вся логика расширения
// Загружается inject.js через <script src="..."> в MAIN world
(() => {
  if (window.__lpPayLogicLoaded) return;
  window.__lpPayLogicLoaded = true;

  const BTN_ID = 'lp-pay-btn';
  const WEBHOOK_PAY = 'https://n8n18297.hostkey.in/webhook/testik';
  const WEBHOOK_AVANS = 'https://n8n18297.hostkey.in/webhook/avans';
  const API_HOST = 'genezis-platform-api.gnzs.ru/events';

  // ===== Состояние =====
  let capturedData = {
    lastEventIds: [],
    lastParentId: null,
    lastPostResponse: null,
    lastGetUrl: null,
    interceptedAt: null,
  };
  let needsSave = false;

  // ===== Webhook-мост к content.js =====
  function callWebhook(endpoint, payload) {
    return new Promise((resolve) => {
      const requestId = Math.random().toString(36).slice(2);
      const handler = (e) => {
        if (e.detail.requestId === requestId) {
          window.removeEventListener('lifepay-webhook-response', handler);
          resolve(e.detail);
        }
      };
      window.addEventListener('lifepay-webhook-response', handler);
      window.dispatchEvent(new CustomEvent('lifepay-webhook-request', {
        detail: { endpoint, payload, requestId },
      }));
      setTimeout(() => {
        window.removeEventListener('lifepay-webhook-response', handler);
        resolve({ ok: false, error: 'timeout' });
      }, 15000);
    });
  }

  // ===== Перехват fetch/XHR =====
  function extractIds(data) {
    if (data && Array.isArray(data.data))
      return data.data.filter(item => item && item.id).map(item => item.id);
    if (Array.isArray(data))
      return data.filter(item => item && item.id).map(item => item.id);
    if (data && data.id) return [data.id];
    return [];
  }

  function dispatchIntercept(type, detail) {
    window.dispatchEvent(new CustomEvent('lifepay-intercept', { detail: { type, ...detail } }));
  }

  // --- XHR ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__lpMethod = (method || 'GET').toUpperCase();
    this.__lpUrl = typeof url === 'string' ? url : '';
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      const url = this.__lpUrl;
      if (!url || !url.includes(API_HOST)) return;
      if (this.status < 200 || this.status >= 300) return;

      if (this.__lpMethod === 'POST') {
        try {
          const resp = JSON.parse(this.responseText);
          const ids = extractIds(resp);
          if (ids.length > 0) {
            capturedData.lastEventIds = ids;
            capturedData.lastPostResponse = resp;
            capturedData.interceptedAt = new Date().toISOString();
            dispatchIntercept('post', { ids, response: resp });
          }
        } catch (e) {}
      } else if (this.__lpMethod === 'GET') {
        const match = url.match(/[?&]parentId=([^&]+)/);
        if (match && match[1]) {
          capturedData.lastParentId = match[1];
          capturedData.lastGetUrl = url;
          capturedData.interceptedAt = new Date().toISOString();
          dispatchIntercept('get', { parentId: match[1], url });
        }
      }
    });
    return origSend.apply(this, args);
  };

  // --- Fetch ---
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = args[0] instanceof Request ? args[0].url : args[0];
    const method = (args[0] instanceof Request ? args[0].method : (args[1]?.method || 'GET')).toUpperCase();
    const response = await origFetch.apply(this, args);

    if (typeof url === 'string' && url.includes(API_HOST)) {
      if (method === 'POST') {
        try {
          const data = await response.clone().json();
          const ids = extractIds(data);
          if (ids.length > 0) {
            capturedData.lastEventIds = ids;
            capturedData.lastPostResponse = data;
            capturedData.interceptedAt = new Date().toISOString();
            dispatchIntercept('post', { ids, response: data });
          }
        } catch (e) {}
      } else if (method === 'GET') {
        const match = url.match(/[?&]parentId=([^&]+)/);
        if (match && match[1]) {
          capturedData.lastParentId = match[1];
          capturedData.lastGetUrl = url;
          capturedData.interceptedAt = new Date().toISOString();
          dispatchIntercept('get', { parentId: match[1], url });
        }
      }
    }
    return response;
  };

  // ===== UI =====
  function checkSaveButton() {
    const saveBtn = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Сохранить');
    const wasVisible = needsSave;
    needsSave = !!saveBtn;
    if (wasVisible !== needsSave) updateButton();
  }

  const saveObserver = new MutationObserver(() => checkSaveButton());
  if (document.body || document.documentElement) {
    saveObserver.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  checkSaveButton();

  // Обновление кнопки при перехвате данных
  window.addEventListener('lifepay-intercept', () => updateButton());

  function updateButton() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;

    const hasData = (capturedData.lastEventIds && capturedData.lastEventIds.length > 0)
                 || (capturedData.lastParentId && capturedData.lastParentId !== '0');
    const amountInput = document.getElementById('lp-amount-input');
    const inputVal = amountInput ? amountInput.value.trim() : '';
    const hasAmount = inputVal !== '' && parseInt(inputVal, 10) > 0;

    if (needsSave) {
      btn.textContent = 'Сохраните запись';
      btn.style.background = '#aaa';
      btn.style.cursor = 'not-allowed';
      btn.style.opacity = '0.6';
      btn.disabled = true;
    } else if (hasData && hasAmount) {
      btn.textContent = 'Принять оплату';
      btn.style.background = '#1cbf72';
      btn.style.cursor = 'pointer';
      btn.style.opacity = '1';
      btn.disabled = false;
    } else {
      btn.textContent = 'Сохраните запись';
      btn.style.background = '#aaa';
      btn.style.cursor = 'not-allowed';
      btn.style.opacity = '0.6';
      btn.disabled = true;
    }
  }

  async function handlePayClick() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;

    const hasData = (capturedData.lastEventIds && capturedData.lastEventIds.length > 0)
                 || (capturedData.lastParentId && capturedData.lastParentId !== '0');
    if (!hasData) {
      btn.textContent = 'Нет данных';
      btn.style.background = '#f0ad4e';
      setTimeout(() => updateButton(), 2000);
      return;
    }

    const amountInput = document.getElementById('lp-amount-input');
    const inputVal = amountInput ? amountInput.value.trim() : '';
    if (inputVal === '' || parseInt(inputVal, 10) <= 0) {
      btn.textContent = 'Укажите сумму';
      btn.style.background = '#f0ad4e';
      setTimeout(() => updateButton(), 2000);
      return;
    }

    const eventIds = capturedData.lastEventIds || [];
    const parentId = capturedData.lastParentId;
    const amount = parseInt(inputVal, 10);

    const payload = {
      event_id: eventIds.length > 0 ? eventIds[0] : parentId,
      sum_to_pay: amount,
      post_response: capturedData.lastPostResponse,
      get_url: capturedData.lastGetUrl,
      intercepted_at: capturedData.interceptedAt,
      iframe_url: window.location.href,
    };

    btn.textContent = 'Отправка...';
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor = 'wait';

    const result = await callWebhook(WEBHOOK_PAY, payload);

    if (result.ok) {
      btn.textContent = 'Оплата оформлена';
      btn.style.background = '#1cbf72';
    } else {
      btn.textContent = 'Ошибка';
      btn.style.background = '#f26252';
    }

    setTimeout(() => {
      btn.disabled = false;
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      updateButton();
    }, 3000);
  }

  async function handleAvansClick(btn) {
    const eventIds = capturedData.lastEventIds || [];
    const parentId = capturedData.lastParentId;
    const event_id = eventIds.length > 0 ? eventIds[0] : parentId;
    if (!event_id) return;

    const originalText = btn.textContent;
    btn.textContent = 'Загрузка...';
    btn.disabled = true;

    const result = await callWebhook(WEBHOOK_AVANS, { event_id });

    if (result.ok && result.data) {
      const data = result.data;
      const amount = data.sum || data.amount || data.remainder || data.remaining;
      const input = document.getElementById('lp-amount-input');
      if (amount && !isNaN(amount) && input) {
        input.value = amount;
        updateButton();
      }
    }

    btn.textContent = originalText;
    btn.disabled = false;
  }

  function getTotalToPay() {
    const rows = document.querySelectorAll('._row_1ki2i_27');
    for (const row of rows) {
      const label = row.querySelector('div:first-child');
      if (label && label.textContent.trim() === 'Итого к оплате:') {
        const valueEl = row.querySelector('div:last-child');
        if (valueEl) {
          const num = valueEl.textContent.replace(/[^\d]/g, '');
          if (num) return parseInt(num, 10);
        }
      }
    }
    return 0;
  }

  function createPaymentBlock(anchor) {
    const wrapper = document.createElement('div');
    wrapper.id = 'lp-pay-wrapper';
    wrapper.style.cssText = 'margin:12px 0;display:flex;flex-direction:column;gap:8px;';

    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;gap:6px;align-items:center;';

    const input = document.createElement('input');
    input.id = 'lp-amount-input';
    input.type = 'text';
    input.maxLength = 9;
    input.placeholder = 'Сумма';
    input.style.cssText = 'flex:0 0 38%;padding:8px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;outline:none;';
    input.addEventListener('focus', () => { input.style.borderColor = '#3788d8'; });
    input.addEventListener('blur', () => { input.style.borderColor = '#ccc'; });
    input.addEventListener('input', updateButton);

    const btn30 = document.createElement('button');
    btn30.textContent = '30%';
    btn30.style.cssText = 'padding:8px 16px;border:1px solid #3788d8;border-radius:4px;font-size:12px;font-weight:600;color:#3788d8;background:#fff;cursor:pointer;white-space:nowrap;min-width:70px;text-align:center;';
    btn30.onmouseenter = () => { btn30.style.background = '#3788d8'; btn30.style.color = '#fff'; };
    btn30.onmouseleave = () => { btn30.style.background = '#fff'; btn30.style.color = '#3788d8'; };
    btn30.onclick = () => {
      const val = getTotalToPay();
      if (val > 0) {
        input.value = Math.round(val * 0.3);
        updateButton();
      }
    };

    const btnRemainder = document.createElement('button');
    btnRemainder.textContent = 'Остаток';
    btnRemainder.style.cssText = 'padding:8px 16px;border:1px solid #3788d8;border-radius:4px;font-size:12px;font-weight:600;color:#3788d8;background:#fff;cursor:pointer;white-space:nowrap;min-width:80px;text-align:center;';
    btnRemainder.onmouseenter = () => { btnRemainder.style.background = '#3788d8'; btnRemainder.style.color = '#fff'; };
    btnRemainder.onmouseleave = () => { btnRemainder.style.background = '#fff'; btnRemainder.style.color = '#3788d8'; };
    btnRemainder.onclick = () => handleAvansClick(btnRemainder);

    const total = getTotalToPay();
    if (total > 0) input.value = total;

    inputRow.append(input, btn30, btnRemainder);

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.style.cssText = 'display:block;width:100%;padding:10px 16px;border:none;border-radius:4px;font-size:13px;font-weight:600;color:#fff;cursor:pointer;text-align:center;';
    btn.onclick = handlePayClick;

    wrapper.append(inputRow, btn);
    anchor.after(wrapper);
    updateButton();
  }

  function injectUI() {
    if (document.getElementById(BTN_ID)) return true;
    const table = document.querySelector('._table_jl8j9_21');
    if (!table) return false;
    const footer = table.closest('._orderForm_mn78f_1')?.querySelector('._footer_1ki2i_1');
    const anchor = footer || table;
    createPaymentBlock(anchor);
    return true;
  }

  // Старт
  setInterval(() => {
    injectUI();
    checkSaveButton();
  }, 500);
})();
