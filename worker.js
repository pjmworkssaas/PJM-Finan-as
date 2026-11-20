/* Fine Gestor — servidor do checkout (Cloudflare Worker) — API de Orders do Mercado Pago
   Variáveis em Settings → Variables and Secrets:
   MP_ACCESS_TOKEN (secret) · PRICE (ex.: 59.90) · ALLOWED_ORIGIN (ex.: https://seuusuario.github.io) · TG_TOKEN (secret) e TG_CHAT (alerta pelo Telegram)
   Grupo com tópicos: TG_CHAT = ID do grupo (-100…) · TG_TOPIC = ID do tópico Pagamentos (número) · TG_TOPIC_SUPORTE = tópico 🔵 Suporte (chamados abertos no programa) · TG_TOPIC_AVISOS = tópico 🔔 Avisos clientes (acompanhamento dos alertas, sem dados pessoais)
   Alertas dos clientes: TG_BOT_TOKEN (secret, bot dos clientes) · TG_BOT_SECRET (secret, senha do webhook do bot) · cron a cada 15 min
   Chave automática: SUPABASE_URL · SUPABASE_SERVICE_KEY (secret) · APP_URL (endereço do programa)
   Opcional: um KV chamado SEEN, para não repetir o aviso da mesma venda.
   No painel do Mercado Pago: Webhooks → Configurar notificações → URL = https://SEU-WORKER/webhook, evento "Order (Mercado Pago)". */
const ORDER = /^ORD[0-9A-Za-z]+$/;
const mapStatus = (s) => (s === 'processed' ? 'approved' : ['failed', 'canceled', 'expired'].includes(s) ? 'rejected' : 'pending');

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(runAlerts(env, new Date((event && event.scheduledTime) || Date.now()))); },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
        const sb0 = sbClient(env);
        if (sb0) {
          const st0 = mapStatus(d.status) === 'rejected' ? 'cancelado' : 'aguardando';
          ctx.waitUntil(sb0('/orders', 'POST', { id: d.id, nome: clean(b.nome, 80), email: payer.email, whatsapp: clean(b.whatsapp, 20).replace(/\D/g, ''), valor: Number(amount), forma: pmId === 'pix' ? 'pix' : (fd.token ? pmId : 'boleto'), status: st0 }, 'resolution=ignore-duplicates,return=minimal')
            .then(() => logEvent(sb0, d.id, 'pedido_criado', st0)).catch(() => {}));
        }
        return json({ id: d.id, status: mapStatus(d.status), detail: d.status_detail, qr_code: pm.qr_code, qr_code_base64: pm.qr_code_base64, ticket_url: pm.ticket_url });
      }
      /* 2) a página pergunta se já foi pago (devolve só o status) */
      if (url.pathname === '/status') {
        const id = url.searchParams.get('id') || '';
        if (!ORDER.test(id)) return json({ error: 'id inválido' }, 400);
        const d = await (await mp('/v1/orders/' + id)).json();
        return json({ status: mapStatus(d.status) });
      }
      /* chamados de suporte abertos dentro do programa */
      if (url.pathname === '/suporte' && req.method === 'POST') return handleSuporte(req, env, json);
      /* bot dos clientes: o Telegram avisa aqui quando alguém fala com o bot */
      if (url.pathname === '/tg' && req.method === 'POST') return handleTg(req, env, json);
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


/* ---------- alertas de vencimento por Telegram (clientes) ---------- */
const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dm = (d) => d.slice(8, 10) + '/' + d.slice(5, 7);
function brtNow(now) { const b = new Date(now.getTime() - 3 * 3600 * 1000); return { hour: b.getUTCHours(), today: b.toISOString().slice(0, 10) }; }
function addD(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function buildDigest(agenda, agendaAt, dias, today, now) {
  const items = (agenda && agenda.items) || [];
  const lim = addD(today, Math.max(0, Number(dias) || 0));
  const late = items.filter((i) => i.d < today), hoje = items.filter((i) => i.d === today), prox = items.filter((i) => i.d > today && i.d <= lim);
  if (!late.length && !hoje.length && !prox.length) return '';
  const row = (i, wd) => '• ' + (wd ? dm(i.d) + ' · ' : '') + esc(i.n) + ' — ' + (i.k === 'in' ? '+' : '') + brl(i.v);
  const blk = (t, a, wd) => (a.length ? '\n' + t + '\n' + a.slice(0, 8).map((i) => row(i, wd)).join('\n') + (a.length > 8 ? '\n… e mais ' + (a.length - 8) : '') + '\n' : '');
  let h = '🔔 <b>Fine Gestor — seu resumo</b>\n' + blk('⚠️ <b>Atrasadas</b>', late, true) + blk('📅 <b>Hoje</b>', hoje, false) + blk('🗓 <b>Próximos ' + (Number(dias) || 0) + ' dias</b>', prox, true);
  h += '\nAbra o Fine Gestor para marcar como pago ou recebido.';
  const age = agendaAt ? Math.floor((now.getTime() - new Date(agendaAt).getTime()) / 86400000) : null;
  if (age !== null && age >= 7) h += '\n⚠️ Seus dados não sincronizam há ' + age + ' dias. Abra o programa para atualizar este resumo.';
  return h;
}

async function tgSend(token, chat, html) {
  const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  return r.status;
}


/* acompanhamento dos alertas no grupo do dono (tópico Avisos clientes). Só números, nunca dados de cliente. */
const avisoOn = (env) => !!(String(env.TG_TOKEN || '').trim() && String(env.TG_CHAT || '').trim() && Number(String(env.TG_TOPIC_AVISOS || '').trim()));
async function avisoAdmin(env, html) {
  const tk = String(env.TG_TOKEN || '').trim(), chat = String(env.TG_CHAT || '').trim(), topic = Number(String(env.TG_TOPIC_AVISOS || '').trim()) || 0;
  if (!tk || !chat || !topic) return;
  try {
    const r = await fetch('https://api.telegram.org/bot' + tk + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, message_thread_id: topic, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!r.ok) console.log('aviso admin: Telegram HTTP', r.status);
  } catch (e) { console.log('aviso admin: erro', e && e.message ? e.message : String(e)); }
}
async function contar(sb, query) {
  const r = await sb('/alert_prefs?select=user_id&' + query + '&limit=1000');
  return r.ok ? ((await r.json()) || []).length : 0;
}
const CONECTADOS = 'enabled=eq.true&chat_id=not.is.null';

async function runAlerts(env, now) {
  const sb = sbClient(env), token = String(env.TG_BOT_TOKEN || '').trim();
  if (!sb || !token) return;
  const { hour, today } = brtNow(now);
  if (hour === 23 && now.getUTCMinutes() < 15 && avisoOn(env)) {            /* relatório diário para o dono, uma vez por dia */
    const conectados = await contar(sb, CONECTADOS), enviados = await contar(sb, 'last_sent=eq.' + today);
    await avisoAdmin(env, '📊 <b>Resumo do dia — alertas de clientes</b>\nClientes conectados: ' + conectados + '\nReceberam o resumo hoje: ' + enviados);
  }
  const r = await sb('/alert_prefs?select=user_id,chat_id,dias,agenda,agenda_at,last_sent&enabled=eq.true&chat_id=not.is.null&hora=eq.' + hour + '&limit=100');
  if (!r.ok) { console.log('alertas: consulta HTTP', r.status); return; }
  const todo = ((await r.json()) || []).filter((p) => p.last_sent !== today).slice(0, 20);   /* limite de chamadas por execução */
  if (!todo.length) return;
  const ids = todo.map((p) => p.user_id).join(',');
  const lr = await sb('/licenses?select=user_id&status=eq.ativa&user_id=in.(' + ids + ')');
  const ok = new Set((lr.ok ? await lr.json() : []).map((l) => l.user_id));
  for (const p of todo) {
    if (!ok.has(p.user_id)) continue;
    const text = buildDigest(p.agenda, p.agenda_at, p.dias, today, now);
    let st = 200;
    if (text) st = await tgSend(token, p.chat_id, text);
    if (st === 403 || st === 400) { await sb('/alert_prefs?user_id=eq.' + p.user_id, 'PATCH', { enabled: false, chat_id: null }, 'return=minimal'); console.log('alertas: bot bloqueado, desligado', p.user_id); if (avisoOn(env)) await avisoAdmin(env, '⚠️ Um cliente bloqueou o bot; os alertas dele foram desligados.\nConectados agora: ' + await contar(sb, CONECTADOS)); continue; }
    if (st === 200) await sb('/alert_prefs?user_id=eq.' + p.user_id, 'PATCH', { last_sent: today }, 'return=minimal');
    console.log('alertas: enviado', p.user_id, text ? 'resumo' : 'nada a avisar', st);
  }
}

async function handleTg(req, env, json) {
  if (!env.TG_BOT_SECRET || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_BOT_SECRET) return json({ error: 'não autorizado' }, 401);
  let u; try { u = await req.json(); } catch (e) { return json({ ok: true }); }
  const m = u && u.message; if (!m || !m.chat || m.chat.type !== 'private') return json({ ok: true });
  const sb = sbClient(env), token = String(env.TG_BOT_TOKEN || '').trim(), text = String(m.text || '').trim(), chat = m.chat.id;
  const say = (t) => tgSend(token, chat, t).catch(() => {});
  if (!sb || !token) return json({ ok: true });
  if (/^\/start/.test(text)) {
    const code = (text.split(/\s+/)[1] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!code) { await say('Olá! Para receber os alertas do Fine Gestor aqui, abra o programa em ⚙️ → Conta e nuvem → Alertas por Telegram e toque em <b>Conectar Telegram</b>.'); return json({ ok: true }); }
    const lr = await sb('/telegram_links?select=user_id&code=eq.' + code + '&expires_at=gt.' + encodeURIComponent(new Date().toISOString()));
    const row = lr.ok ? ((await lr.json()) || [])[0] : null;
    if (!row) { await say('Este código expirou ou não é válido. Volte ao programa e toque em <b>Conectar Telegram</b> de novo.'); return json({ ok: true }); }
    const up = await sb('/alert_prefs', 'POST', { user_id: row.user_id, chat_id: chat, enabled: true }, 'resolution=merge-duplicates,return=minimal');
    await sb('/telegram_links?code=eq.' + code, 'DELETE', null, 'return=minimal');
    if (up.ok && avisoOn(env)) await avisoAdmin(env, '🔔 <b>Novo cliente conectou o Telegram</b>\nConectados agora: ' + await contar(sb, CONECTADOS));
    await say(up.ok ? '✅ <b>Conectado!</b> Você vai receber aqui o resumo dos vencimentos. Ajuste o horário e a antecedência no programa. Para parar a qualquer momento, envie /parar.' : 'Não foi possível conectar agora. Tente de novo em instantes.');
    return json({ ok: true });
  }
  if (/^\/parar/.test(text)) {
    const pr = await sb('/alert_prefs?chat_id=eq.' + chat, 'PATCH', { enabled: false }, 'return=representation');
    const afetados = pr.ok ? ((await pr.json()) || []) : [];
    if (afetados.length && avisoOn(env)) await avisoAdmin(env, 'ℹ️ Um cliente desligou os alertas (/parar).\nConectados agora: ' + await contar(sb, CONECTADOS));
    await say('Alertas desligados. Para voltar a receber, ative em ⚙️ → Alertas por Telegram, no programa.');
    return json({ ok: true });
  }
  await say('Eu envio o resumo dos seus vencimentos do Fine Gestor. Para configurar, use ⚙️ → Alertas por Telegram no programa. Envie /parar para desligar.');
  return json({ ok: true });
}


/* ---------- suporte: chamados do programa vão para o tópico Suporte do grupo ---------- */
async function handleSuporte(req, env, json) {
  const sb = sbClient(env);
  const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!sb || !jwt) return json({ error: 'login' }, 401);
  const ur = await fetch(String(env.SUPABASE_URL).trim().replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: String(env.SUPABASE_SERVICE_KEY).trim(), Authorization: 'Bearer ' + jwt } });
  const user = ur.ok ? await ur.json() : null;                    /* quem manda é confirmado pelo Supabase, nunca pelo que a página diz */
  if (!user || !user.id) return json({ error: 'login' }, 401);
  let b; try { b = await req.json(); } catch (e) { return json({ error: 'dados' }, 400); }
  const assunto = String(b.assunto || '').trim(), mensagem = String(b.mensagem || '').trim();
  if (!assunto || !mensagem || assunto.length > 120 || mensagem.length > 2000) return json({ error: 'dados' }, 400);
  const lr = await sb('/licenses?select=chave,order_id,nome&user_id=eq.' + user.id + '&status=eq.ativa&limit=1');
  const lic = lr.ok ? ((await lr.json()) || [])[0] : null;
  if (!lic) return json({ error: 'licenca' }, 403);
  const cr = await sb('/support_tickets?select=id&user_id=eq.' + user.id + '&created_at=gt.' + encodeURIComponent(new Date(Date.now() - 3600 * 1000).toISOString()) + '&limit=10');
  if (cr.ok && ((await cr.json()) || []).length >= 5) return json({ error: 'limite' }, 429);   /* no máximo 5 chamados por hora */
  let nome = lic.nome || '', zap = '';
  if (lic.order_id) {
    const or = await sb('/orders?select=nome,whatsapp&id=eq.' + encodeURIComponent(lic.order_id) + '&limit=1');
    const o = or.ok ? ((await or.json()) || [])[0] : null;
    if (o) { nome = o.nome || nome; zap = String(o.whatsapp || '').replace(/\D/g, ''); }
  }
  const ref = Array.from(crypto.getRandomValues(new Uint8Array(3)), (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  const tk = String(env.TG_TOKEN || '').trim(), chat = String(env.TG_CHAT || '').trim(), topic = Number(String(env.TG_TOPIC_SUPORTE || '').trim()) || 0;
  if (!tk || !chat) return json({ error: 'indisponivel' }, 503);
  const wa = zap ? 'https://wa.me/' + zap + '?text=' + enc('Olá' + (nome ? ', ' + nome.split(' ')[0] : '') + '! Sobre o seu chamado #' + ref + ' (' + assunto + '):') : '';
  const msgEsc = esc(mensagem).slice(0, 2500).replace(/&[a-z]*$/, '') + (esc(mensagem).length > 2500 ? '…' : '');
  const html = '🔵 <b>Novo chamado #' + ref + '</b>\n\n<b>Assunto:</b> ' + esc(assunto) + '\n<b>Mensagem:</b>\n' + msgEsc + '\n\n<b>Cliente:</b> ' + esc(nome || '-') + '\n<b>E-mail:</b> ' + esc(user.email || '-') + '\n<b>WhatsApp:</b> ' + esc(zap || '-') + '\n<b>Chave:</b> <code>' + esc(lic.chave) + '</code>' + (wa ? '\n\n<a href="' + wa + '">📲 Responder pelo WhatsApp</a>' : '');
  const plain = '🔵 Novo chamado #' + ref + '\n\nAssunto: ' + assunto + '\nMensagem:\n' + mensagem.slice(0, 2500) + '\n\nCliente: ' + (nome || '-') + '\nE-mail: ' + (user.email || '-') + '\nWhatsApp: ' + (zap || '-') + '\nChave: ' + lic.chave;
  const send = (extra, withTopic = true) => fetch('https://api.telegram.org/bot' + tk + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, disable_web_page_preview: true, ...(withTopic && topic ? { message_thread_id: topic } : {}), ...extra }),
  });
  let t = await send({ parse_mode: 'HTML', text: html });
  const erro = t.ok ? '' : (await t.text()).slice(0, 200);
  if (!t.ok) console.log('suporte: telegram HTTP', t.status, erro);
  if (!t.ok && topic && /thread/i.test(erro)) { console.log('ERRO: tópico de suporte ' + topic + ' não encontrado, enviando sem tópico. Confira TG_TOPIC_SUPORTE.'); t = await send({ parse_mode: 'HTML', text: html }, false); }
  if (!t.ok) t = await send({ text: plain });
  if (!t.ok) return json({ error: 'envio' }, 502);
  const ins = await sb('/support_tickets', 'POST', { ref, user_id: user.id, email: user.email || null, assunto, mensagem }, 'return=minimal');
  if (!ins.ok) console.log('suporte: não guardou o chamado, HTTP', ins.status);
  return json({ ok: true, id: ref });
}

async function notify(id, env, mp) {
  try { await notifyInner(id, env, mp); } catch (e) { console.log('ERRO no aviso:', e && e.message ? e.message : String(e)); }
}

const enc = (t) => encodeURIComponent(t).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* sem O, I, 0 e 1, para não confundir */
function genKey() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  const c = Array.from(b, (x) => KEY_ALPHABET[x % 32]).join('');
  return 'FG-' + c.slice(0, 4) + '-' + c.slice(4, 8) + '-' + c.slice(8);
}

/* cliente do Supabase com a chave de serviço (só existe aqui no servidor) */
function sbClient(env) {
  if (!(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY)) return null;
  const base = String(env.SUPABASE_URL).trim().replace(/\/+$/, '') + '/rest/v1';
  const k = String(env.SUPABASE_SERVICE_KEY).trim();
  return (path, method, body, prefer) => fetch(base + path, {
    method: method || 'GET',
    headers: { apikey: k, Authorization: 'Bearer ' + k, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
/* histórico para o painel de administração (nunca derruba o fluxo principal) */
const logEvent = (sb, order_id, kind, detail) =>
  sb('/events', 'POST', { order_id, kind, detail: String(detail || '').slice(0, 300) }, 'return=minimal').catch(() => {});

/* grava o pedido e cria (uma única vez) a licença desse pedido */
async function ensureLicense(env, order) {
  const sb = sbClient(env);
  const find = async () => {
    const r = await sb('/licenses?select=chave&order_id=eq.' + encodeURIComponent(order.id) + '&limit=1');
    if (!r.ok) throw new Error('consulta de licença HTTP ' + r.status);
    const j = await r.json();
    return j && j[0] ? j[0].chave : null;
  };
  const o = await sb('/orders', 'POST', { id: order.id, nome: order.nome, email: order.email, whatsapp: order.whatsapp, valor: order.valor, forma: order.forma, status: 'pago' }, 'resolution=merge-duplicates,return=minimal');
  if (!o.ok) throw new Error('gravar pedido HTTP ' + o.status);
  const had = await find();
  if (had) return { chave: had, nova: false };
  for (let i = 0; i < 3; i++) {
    const chave = genKey();
    const r = await sb('/licenses', 'POST', { chave, order_id: order.id, email: order.email, nome: order.nome }, 'return=representation');
    if (r.ok) { await logEvent(sb, order.id, 'pago', 'R$ ' + order.valor + ' · ' + order.forma); await logEvent(sb, order.id, 'licenca_criada', chave); return { chave, nova: true }; }
    const again = await find();            /* outra chamada criou ao mesmo tempo */
    if (again) return { chave: again, nova: false };
    if (r.status !== 409) throw new Error('criar licença HTTP ' + r.status);
  }
  throw new Error('não foi possível criar a licença');
}

async function notifyInner(id, env, mp) {
  const tgToken = String(env.TG_TOKEN || '').trim(), tgChat = String(env.TG_CHAT || '').trim(), topic = String(env.NTFY_TOPIC || '').trim();
  if (!(tgToken && tgChat) && !topic) { console.log('ERRO: nenhum canal de alerta configurado (TG_TOKEN e TG_CHAT, ou NTFY_TOPIC)'); return; }
  const r = await mp('/v1/orders/' + id);
  const d = await r.json();
  const pay0 = (((d.transactions || {}).payments || [])[0]) || {};
  console.log('webhook', id, 'GET order HTTP', r.status, 'status', d.status, 'pagamento', pay0.status);
  const paid = d.status === 'processed' || pay0.status === 'processed' || d.status_detail === 'accredited';
  if (!paid) {
    if (['failed', 'canceled', 'expired'].includes(d.status)) {
      const sbc = sbClient(env);
      if (sbc) {
        const pr = await sbc('/orders?id=eq.' + encodeURIComponent(d.id) + '&status=eq.aguardando', 'PATCH', { status: 'cancelado' }, 'return=minimal');
        console.log('pedido marcado como cancelado', d.status, 'HTTP', pr.status);
        await logEvent(sbc, d.id, 'cancelado', d.status + (d.status_detail ? ' · ' + d.status_detail : ''));
      }
    }
    return;
  }
  const pm = pay0.payment_method || {};
  const who = String(d.description || '').split(' | ').slice(1);
  const nome = who[0] || '', email = who[1] || '', zap = (who[2] || '').replace(/\D/g, '');

  let lic = null;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    try {
      lic = await ensureLicense(env, { id: d.id, nome, email, whatsapp: zap, valor: Number(d.total_amount), forma: pm.id || '' });
      console.log('licença', lic.nova ? 'criada' : 'já existia');
      if (!lic.nova) return;               /* já foi avisado antes: não repete */
    } catch (e) { console.log('ERRO licença:', e && e.message ? e.message : String(e)); }
  } else if (env.SEEN) {
    if (await env.SEEN.get(id)) return; await env.SEEN.put(id, '1', { expirationTtl: 60 * 60 * 24 * 90 });
  }

  const dados = 'Nome: ' + (nome || '-') + '\nE-mail: ' + (email || '-') + '\nWhatsApp: ' + (zap || '-') +
    '\nValor: R$ ' + d.total_amount + '\nForma: ' + (pm.id || '-') + '\nPedido: ' + d.id + '\n\n';
  let msg = dados, html = esc(dados);
  if (lic) {
    const app = String(env.APP_URL || 'https://pjmworkssaas.github.io/PJM-Finan-as/').trim();
    const texto = 'Olá' + (nome ? ', ' + nome.split(' ')[0] : '') + '! Seu pagamento do Fine Gestor foi confirmado ✅\n\nSua chave de ativação: ' + lic.chave +
      '\n\nComo começar:\n1. Acesse ' + app + '\n2. Crie sua conta (e-mail e senha)\n3. Digite a chave quando o programa pedir\n\nQualquer dúvida, é só responder esta mensagem.';
    const wa = zap ? 'https://wa.me/' + zap + '?text=' + enc(texto) : '';
    msg += '🔑 Chave: ' + lic.chave + '\n\n' + (wa ? 'Enviar ao cliente pelo WhatsApp:\n' + wa : 'Cliente sem WhatsApp informado: envie a chave por e-mail.');
    html += '🔑 Chave: <code>' + esc(lic.chave) + '</code>\n\n' + (wa ? '<a href="' + wa + '">📲 Enviar a chave ao cliente pelo WhatsApp</a>' : 'Cliente sem WhatsApp informado: envie a chave por e-mail.');
  } else {
    msg += 'Gere a chave e envie ao cliente.'; html += 'Gere a chave e envie ao cliente.';
  }
  const tgTopic = Number(String(env.TG_TOPIC || '').trim()) || 0;   /* ID do tópico do grupo; vazio = envia direto ao chat */
  if (String(env.TG_TOPIC || '').trim() && !tgTopic) console.log('AVISO: TG_TOPIC precisa ser um número; ignorado');
  console.log('enviando alerta · telegram:', !!(tgToken && tgChat), '· tópico:', tgTopic || 'nenhum', '· ntfy:', !!topic, '· chave:', !!lic);
  if (tgToken && tgChat) {
    const send = (extra, withTopic = true) => fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChat, disable_web_page_preview: true, ...(withTopic && tgTopic ? { message_thread_id: tgTopic } : {}), ...extra }),
    });
    try {
      let t = await send({ parse_mode: 'HTML', text: '💰 <b>Venda aprovada - Fine Gestor</b>\n\n' + html });
      const erro = t.ok ? '' : (await t.text()).slice(0, 200);
      console.log('telegram HTTP', t.status, erro);
      /* tópico errado ou apagado: a venda não pode se perder, então vai para o chat geral do grupo e o log avisa */
      if (!t.ok && tgTopic && /thread/i.test(erro)) { console.log('ERRO: tópico ' + tgTopic + ' não encontrado, enviando sem tópico. Confira TG_TOPIC.'); t = await send({ parse_mode: 'HTML', text: '💰 <b>Venda aprovada - Fine Gestor</b>\n\n' + html }, false); console.log('telegram sem tópico HTTP', t.status); }
      if (!t.ok) { t = await send({ text: '💰 Venda aprovada - Fine Gestor\n\n' + msg }); console.log('telegram texto puro HTTP', t.status); }
      if (t.ok) return;
    } catch (e) { console.log('ERRO telegram:', e && e.message ? e.message : String(e)); }
  }
  if (topic) {
    const n = await fetch('https://ntfy.sh/' + topic, { method: 'POST', headers: { Title: 'Venda aprovada - Fine Gestor', Tags: 'moneybag' }, body: msg });
    console.log('ntfy HTTP', n.status);
  }
}