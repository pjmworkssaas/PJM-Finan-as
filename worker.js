/* Fine Gestor — servidor do checkout (Cloudflare Worker) — API de Orders do Mercado Pago
   Variáveis em Settings → Variables and Secrets:
   MP_ACCESS_TOKEN (secret) · PRICE (ex.: 59.90) · ALLOWED_ORIGIN (ex.: https://seuusuario.github.io) · TG_TOKEN (secret) e TG_CHAT para o alerta pelo Telegram (ou NTFY_TOPIC como alternativa)
   Opcional: um KV chamado SEEN, para não repetir o aviso da mesma venda.
   No painel do Mercado Pago: Webhooks → Configurar notificações → URL = https://SEU-WORKER/webhook, evento "Order (Mercado Pago)". */
const ORDER = /^ORD[0-9A-Za-z]+$/;
const mapStatus = (s) => (s === 'processed' ? 'approved' : ['failed', 'canceled', 'expired'].includes(s) ? 'rejected' : 'pending');

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    const mp = (path, opt = {}) => fetch('https://api.mercadopago.com' + path, {
      ...opt, headers: { Authorization: 'Bearer ' + env.MP_ACCESS_TOKEN, 'Content-Type': 'application/json', ...(opt.headers || {}) },
    });
    const clean = (v, n) => String(v || '').replace(/[<>|]/g, '').slice(0, n);
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    try {
      /* 1) cria o pedido — o valor vem SEMPRE do servidor, nunca da página */
      if (url.pathname === '/pay' && req.method === 'POST') {
        const b = await req.json();
        const fd = b.formData || {}, fp = fd.payer || {};
        const orderId = clean(b.orderId, 64) || crypto.randomUUID();
        const amount = Number(env.PRICE).toFixed(2);
        const payer = { email: clean(fp.email, 120) };
        if (fp.identification) payer.identification = fp.identification;
        const pmId = String(fd.payment_method_id || '');
        let tries;
        if (pmId === 'pix') tries = [{ payment_method: { id: 'pix', type: 'bank_transfer' } }];
        else if (fd.token) {
          const type = /debit/i.test(String(b.paymentTypeId || b.selected || '')) ? 'debit_card' : 'credit_card';
          tries = [{ payment_method: { id: pmId, type, token: fd.token, installments: Number(fd.installments) || 1 } }];
        } else {
          ['first_name', 'last_name', 'address'].forEach((k) => { if (fp[k]) payer[k] = fp[k]; });
          tries = ['boleto', 'bolbradesco'].map((id) => ({ payment_method: { id, type: 'ticket' }, expiration_time: 'P3D' }));
        }
        const desc = ['Fine Gestor', clean(b.nome, 80), payer.email, clean(b.whatsapp, 20)].join(' | ');
        let d, ok = false;
        for (let i = 0; i < tries.length && !ok; i++) {
          const r = await mp('/v1/orders', {
            method: 'POST', headers: { 'X-Idempotency-Key': orderId + '-' + i },
            body: JSON.stringify({ type: 'online', processing_mode: 'automatic', total_amount: amount, external_reference: orderId, description: desc, payer, transactions: { payments: [{ amount, ...tries[i] }] } }),
          });
          d = await r.json(); ok = r.ok;
        }
        if (!ok) { const e = (d.errors && d.errors[0]) || {}; return json({ error: e.message || d.message || 'Pagamento não aceito.' }, 400); }
        const pm = (((d.transactions || {}).payments || [])[0] || {}).payment_method || {};
        return json({ id: d.id, status: mapStatus(d.status), detail: d.status_detail, qr_code: pm.qr_code, qr_code_base64: pm.qr_code_base64, ticket_url: pm.ticket_url });
      }
      /* 2) a página pergunta se já foi pago (devolve só o status) */
      if (url.pathname === '/status') {
        const id = url.searchParams.get('id') || '';
        if (!ORDER.test(id)) return json({ error: 'id inválido' }, 400);
        const d = await (await mp('/v1/orders/' + id)).json();
        return json({ status: mapStatus(d.status) });
      }
      /* 3) o Mercado Pago avisa aqui; conferimos na API e alertamos você */
      if (url.pathname === '/webhook') {
        let id = url.searchParams.get('data.id');
        if (!id) { try { id = ((await req.json()).data || {}).id; } catch (e) {} }
        if (id && ORDER.test(String(id))) ctx.waitUntil(notify(String(id), env, mp));
        return json({ ok: true });
      }
    } catch (e) { return json({ error: 'Erro interno.' }, 500); }
    return json({ error: 'não encontrado' }, 404);
  },
};

async function notify(id, env, mp) {
  try { await notifyInner(id, env, mp); } catch (e) { console.log('ERRO no aviso:', e && e.message ? e.message : String(e)); }
}

async function notifyInner(id, env, mp) {
  const tgToken = String(env.TG_TOKEN || '').trim(), tgChat = String(env.TG_CHAT || '').trim(), topic = String(env.NTFY_TOPIC || '').trim();
  if (!(tgToken && tgChat) && !topic) { console.log('ERRO: nenhum canal de alerta configurado (TG_TOKEN e TG_CHAT, ou NTFY_TOPIC)'); return; }
  const r = await mp('/v1/orders/' + id);
  const d = await r.json();
  const pay0 = (((d.transactions || {}).payments || [])[0]) || {};
  console.log('webhook', id, 'GET order HTTP', r.status, 'status', d.status, 'pagamento', pay0.status);
  const paid = d.status === 'processed' || pay0.status === 'processed' || d.status_detail === 'accredited';
  if (!paid) return;
  if (env.SEEN) { if (await env.SEEN.get(id)) return; await env.SEEN.put(id, '1', { expirationTtl: 60 * 60 * 24 * 90 }); }
  const pm = pay0.payment_method || {};
  const who = String(d.description || '').split(' | ').slice(1);
  const msg = 'Nome: ' + (who[0] || '-') + '\nE-mail: ' + (who[1] || '-') + '\nWhatsApp: ' + (who[2] || '-') +
    '\nValor: R$ ' + d.total_amount + '\nForma: ' + (pm.id || '-') + '\nPedido: ' + d.id + '\n\nGere a chave e envie ao cliente.';
  console.log('enviando alerta · telegram:', !!(tgToken && tgChat), '· ntfy:', !!topic);
  if (tgToken && tgChat) {
    try {
      const t = await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: '💰 Venda aprovada - Fine Gestor\n\n' + msg }),
      });
      console.log('telegram HTTP', t.status, t.ok ? '' : (await t.text()).slice(0, 200));
      if (t.ok) return;
    } catch (e) { console.log('ERRO telegram:', e && e.message ? e.message : String(e)); }
  }
  if (topic) {
    const n = await fetch('https://ntfy.sh/' + topic, { method: 'POST', headers: { Title: 'Venda aprovada - Fine Gestor', Tags: 'moneybag' }, body: msg });
    console.log('ntfy HTTP', n.status);
  }
}
