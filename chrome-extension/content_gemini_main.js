// content_gemini_main.js — MAINワールドで動作 (page JS context)
// ページ自身の batchexecute XHR/fetch を傍受して AT token と応答データを取得する
(function () {
  'use strict';

  const STORE = { at: '', log: [], requests: [] };

  function captureBody(body) {
    const s = body instanceof URLSearchParams ? body.toString()
            : typeof body === 'string' ? body : '';
    const m = s.match(/(?:^|&)at=([^&]+)/);
    if (m) STORE.at = decodeURIComponent(m[1]);

    // リクエストペイロードもログ (デバッグ用)
    const fr = s.match(/f\.req=([^&]+)/);
    if (fr) {
      try {
        const parsed = JSON.parse(decodeURIComponent(fr[1]));
        const rpcid   = parsed?.[0]?.[0]?.[0];
        const payload = parsed?.[0]?.[0]?.[1];
        if (rpcid) {
          STORE.requests.push({ rpcid, payload });
          console.log(`[GeminiMain] intercept req: ${rpcid}`, typeof payload === 'string' ? payload.slice(0, 300) : payload);
        }
      } catch {}
    }
  }

  function emitResponse(text) {
    STORE.log.push(text);
    window.dispatchEvent(new CustomEvent('__gemini_batch_resp__', { detail: { text } }));
  }

  // ── XHR パッチ ─────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__batch__ = typeof url === 'string' && url.includes('batchexecute');
    this.__burl__  = url;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this.__batch__) {
      captureBody(body);
      this.addEventListener('load', () => emitResponse(this.responseText), { once: true });
    }
    return _send.apply(this, arguments);
  };

  // ── fetch パッチ ────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? '');
    if (url.includes('batchexecute')) {
      captureBody(init?.body);
      return _fetch.call(this, input, init).then(res => {
        res.clone().text().then(emitResponse);
        return res;
      });
    }
    return _fetch.call(this, input, init);
  };

  // ── ISOLATEDワールドからの問い合わせに応答 ─────────────────
  window.addEventListener('__gemini_req_at__', () => {
    window.dispatchEvent(new CustomEvent('__gemini_at__', { detail: { at: STORE.at } }));
  });

  window.addEventListener('__gemini_req_log__', () => {
    window.dispatchEvent(new CustomEvent('__gemini_log__', { detail: { requests: STORE.requests } }));
  });

  console.log('[GeminiMain] batchexecute interceptor ready');
})();
