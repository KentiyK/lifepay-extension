// pay-logic.js — хостится на Vercel, вся логика расширения
// Загружается inject.js через <script src="..."> в MAIN world
// Исправления:
//  1. Атомарный снапшот вместо кучи несвязанных полей
//  2. Единый deriveState() + renderButton() вместо дублированной логики
//  3. Убран MutationObserver на весь документ (один setInterval)
//  4. Флаг sending: кнопка не активируется во время полёта запроса
//  5. Кнопка «Остаток»: busy-состояние и индикация ошибки
//  6. Автозаполнение суммы, когда «Итого к оплате:» появляется после сохранения
(() => {
  if (window.__lpPayLogicLoaded) return;
  window.__lpPayLogicLoaded = true;
  console.log('[LP] pay-logic.js loaded, url:', window.location.href);

  const BTN_ID = 'lp-pay-btn';
  const WEBHOOK_PAY = 'https://n8n18297.hostkey.in/webhook/testik';
  const WEBHOOK_AVANS = 'https://n8n18297.hostkey.in/webhook/avans';
  const API_HOST = 'genezis-platform-api.gnzs.ru/events';

  // ===== Состояние =====
  // Атомарный снапшот: eventIds и parentId всегда принадлежат одной записи.
  // GET с новым parentId открывает новый снапшот (старые ids сбрасываются),
  // POST заполняет текущий снапшот (ids + postResponse).
  // После оплаты снапшот НЕ чистится: аванс + доплата — штатный сценарий.
  let captured = null;

  // Процесс оплаты в полёте — блокирует перерисовку кнопки (fix #4)
  let sending = false;
  let avansBusy = false;
  // Пользователь трогал поле суммы руками — автозаполнение больше не трогает его
  let inputTouched = false;

  // Временное сообщение на кнопке (успех/ошибка), автосброс через 2 сек
  let feedback = null;
  let feedbackTimer = null;

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

  function applyPostCapture(ids, response) {
    captured = captured || {};
    captured.eventIds = ids;
    captured.postResponse = response;
    captured.interceptedAt = new Date().toISOString();
    dispatchIntercept('post', { ids, response });
  }

  function applyGetCapture(parentId, url) {
    if (!captured || captured.parentId !== parentId) {
      // Новая запись: старые ids не могут относиться к ней — сбрасываем
      captured = {
        parentId,
        getUrl: url,
        eventIds: [],
        postResponse: null,
        interceptedAt: new Date().toISOString(),
      };
    } else {
      captured.getUrl = url;
      captured.interceptedAt = new Date().toISOString();
    }
    dispatchIntercept('get', { parentId, url });
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
          if (ids.length > 0) applyPostCapture(ids, resp);
        } catch (e) {}
      } else if (this.__lpMethod === 'GET') {
        const match = url.match(/[?&]parentId=([^&]+)/);
        if (match && match[1]) applyGetCapture(match[1], url);
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
          if (ids.length > 0) applyPostCapture(ids, data);
        } catch (e) {}
      } else if (method === 'GET') {
        const match = url.match(/[?&]parentId=([^&]+)/);
        if (match && match[1]) applyGetCapture(match[1], url);
      }
    }
    return response;
  };

  // ===== UI: единый источник правды (fix #2) =====
  function hasSaveButton() {
    return [...document.querySelectorAll('button')]
      .some(b => b.textContent.trim() === 'Сохранить');
  }

  // ===== Диагностика (временный лог, пишет только при изменении состояния) =====
  let lastLogSig = '';

  function logDiagnostics(s) {
    const buttons = [...document.querySelectorAll('button')]
      .filter(b => b.textContent.trim() === 'Сохранить')
      .map(b => ({
        disabled: !!b.disabled,
        visible: b.getClientRects().length > 0,
        cls: (b.className || '').toString().slice(0, 60),
        parentCls: (b.parentElement && b.parentElement.className || '').toString().slice(0, 60),
      }));
    const sig = JSON.stringify({ s, buttons });
    if (sig === lastLogSig) return;
    lastLogSig = sig;
    console.log('[LP] state:', s, '| save-buttons:', buttons);
  }

  function deriveState() {
    const hasData = !!captured
      && ((captured.eventIds && captured.eventIds.length > 0)
       || (captured.parentId && captured.parentId !== '0'));
    const amountInput = document.getElementById('lp-amount-input');
    const inputVal = amountInput ? amountInput.value.trim() : '';
    const hasAmount = inputVal !== '' && parseInt(inputVal, 10) > 0;
    const needsSave = hasSaveButton();
    return {
      hasData,
      hasAmount,
      needsSave,
      canPay: !sending && hasData && hasAmount && !needsSave,
    };
  }

  function showFeedback(text, color) {
    clearTimeout(feedbackTimer);
    feedback = { text, color };
    renderButton();
    feedbackTimer = setTimeout(() => {
      feedback = null;
      renderButton();
    }, 2000);
  }

  function renderButton() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;

    const s = deriveState();
    let text = 'Сохраните запись';
    let bg = '#aaa';
    let cursor = 'not-allowed';
    let opacity = '0.6';
    let disabled = true;

    if (sending) {
      text = 'Отправка...';
      bg = '#3788d8';
      cursor = 'wait';
      opacity = '0.7';
    } else if (feedback) {
      text = feedback.text;
      bg = feedback.color;
    } else {
      logDiagnostics(s);
      if (s.canPay) {
        text = 'Принять оплату';
        bg = '#1cbf72';
        cursor = 'pointer';
        opacity = '1';
        disabled = false;
      }
    }

    btn.textContent = text;
    btn.style.background = bg;
    btn.style.cursor = cursor;
    btn.style.opacity = opacity;
    btn.disabled = disabled;
  }

  // Перерисовка при новых перехваченных данных (сама кнопка учтёт sending)
  window.addEventListener('lifepay-intercept', () => renderButton());

  async function handlePayClick() {
    const btn = document.getElementById(BTN_ID);
    if (!btn || sending) return;

    const s = deriveState();
    if (!s.hasData) { showFeedback('Нет данных', '#f0ad4e'); return; }
    if (!s.hasAmount) { showFeedback('Укажите сумму', '#f0ad4e'); return; }
    if (s.needsSave) { showFeedback('Сначала сохраните', '#f0ad4e'); return; }

    const eventIds = captured.eventIds || [];
    const parentId = captured.parentId;
    const amount = parseInt(document.getElementById('lp-amount-input').value.trim(), 10);

    const payload = {
      event_id: eventIds.length > 0 ? eventIds[0] : parentId,
      sum_to_pay: amount,
      post_response: captured.postResponse,
      get_url: captured.getUrl,
      intercepted_at: captured.interceptedAt,
      iframe_url: window.location.href,
    };

    sending = true;
    renderButton();

    const result = await callWebhook(WEBHOOK_PAY, payload);
    sending = false;

    if (result.ok) showFeedback('Оплата оформлена', '#1cbf72');
    else showFeedback('Ошибка', '#f26252');
  }

  // Кнопка «Остаток»: busy-состояние + индикация ошибки (fix #5)
  function restoreAvansButton(btn, originalText) {
    btn.textContent = originalText;
    btn.style.color = '#3788d8';
    btn.style.borderColor = '#3788d8';
    btn.disabled = false;
  }

  async function handleAvansClick(btn) {
    if (avansBusy || sending) return;
    const eventIds = captured ? captured.eventIds || [] : [];
    const parentId = captured ? captured.parentId : null;
    const event_id = eventIds.length > 0 ? eventIds[0] : parentId;
    if (!event_id) return;

    const originalText = btn.textContent;
    avansBusy = true;
    btn.textContent = 'Загрузка...';
    btn.disabled = true;

    const result = await callWebhook(WEBHOOK_AVANS, { event_id });
    avansBusy = false;

    if (result.ok && result.data) {
      const data = result.data;
      const amount = data.sum || data.amount || data.remainder || data.remaining;
      const input = document.getElementById('lp-amount-input');
      if (amount && !isNaN(amount) && input) {
        input.value = amount;
        renderButton();
      }
      restoreAvansButton(btn, originalText);
    } else {
      btn.textContent = 'Ошибка';
      btn.style.color = '#f26252';
      btn.style.borderColor = '#f26252';
      setTimeout(() => restoreAvansButton(btn, originalText), 2000);
    }
  }

  function getTotalToPay() {
    const rows = document.querySelectorAll('[class*="_row_"]');
    console.log('[LP] getTotalToPay: rows found=', rows.length);
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

  // Автозаполнение суммы: в create-режиме «Итого к оплате:» появляется
  // только после сохранения сделки — подставляем его, пока поле пустое
  function autoFillAmount() {
    const input = document.getElementById('lp-amount-input');
    if (!input || inputTouched) return;
    if (input.value.trim() !== '') return;
    const total = getTotalToPay();
    if (total > 0) {
      input.value = total;
      console.log('[LP] autofill amount:', total);
      renderButton();
    }
  }

  function createPaymentBlock(anchor) {
    console.log('[LP] createPaymentBlock: anchor=', anchor);
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
    input.addEventListener('input', () => { inputTouched = true; renderButton(); });

    const btn30 = document.createElement('button');
    btn30.textContent = '30%';
    btn30.style.cssText = 'padding:8px 16px;border:1px solid #3788d8;border-radius:4px;font-size:12px;font-weight:600;color:#3788d8;background:#fff;cursor:pointer;white-space:nowrap;min-width:70px;text-align:center;';
    btn30.onmouseenter = () => { btn30.style.background = '#3788d8'; btn30.style.color = '#fff'; };
    btn30.onmouseleave = () => { btn30.style.background = '#fff'; btn30.style.color = '#3788d8'; };
    btn30.onclick = () => {
      const val = getTotalToPay();
      if (val > 0) {
        input.value = Math.round(val * 0.3);
        renderButton();
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
    renderButton();
  }

  function injectUI() {
    if (document.getElementById(BTN_ID)) return true;
    const table = document.querySelector('[class*="_table_"]');
    console.log('[LP] injectUI: table=', table);
    if (!table) return false;
    const orderForm = table.closest('[class*="_orderForm_"]');
    console.log('[LP] injectUI: orderForm=', orderForm);
    const footer = orderForm?.querySelector('[class*="_footer_"]');
    console.log('[LP] injectUI: footer=', footer);
    const anchor = footer || table;
    createPaymentBlock(anchor);
    return true;
  }

  // Старт: один цикл вместо MutationObserver + setInterval (fix #3)
  console.log('[LP] starting setInterval, document.readyState:', document.readyState);
  setInterval(() => {
    const injected = injectUI();
    autoFillAmount();
    renderButton();
    console.log('[LP] tick: injectUI=', injected, 'captured=', !!captured, 'btnExists=', !!document.getElementById(BTN_ID));
  }, 500);
})();
