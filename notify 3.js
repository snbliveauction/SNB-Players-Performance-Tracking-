/* Cloudflare Pages Function: POST /api/notify   (admin only)
   body: { kind: 'announce', title, body, url }                    -> every saved device
         { kind: 'personal', items: [{ pid, title, body, url }] }  -> only the devices of that player
         { kind: 'test', token }                                   -> one device, returns the exact error (for debugging)
   Every announce/personal message is also saved in the "notifications" collection, so the site can show a list.
   Secrets: FIREBASE_SERVICE_ACCOUNT (whole JSON), FIREBASE_API_KEY (web apiKey).
   Free plan: 50 outgoing requests per call, so the code counts them and stops before the limit. */
const MAX_REQ = 48;
const enc = new TextEncoder();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

function b64u(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function accessToken(sa, f) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64u(enc.encode(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3000
  })));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + claim));
  const r = await f('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + head + '.' + claim + '.' + b64u(sig)
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('oauth failed');
  return j.access_token;
}

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const fv = (v) => (typeof v === 'number' ? { integerValue: String(Math.round(v)) } : { stringValue: String(v) });

export async function onRequestPost({ request, env }) {
  let used = 0;
  const f = (u, o) => { used++; return fetch(u, o); };
  try {
    if (!env.FIREBASE_SERVICE_ACCOUNT || !env.FIREBASE_API_KEY) return json({ error: 'server not configured' }, 500);
    const idToken = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!idToken) return json({ error: 'sign in required' }, 401);

    /* who is calling? */
    const who = await f('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(env.FIREBASE_API_KEY), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken })
    });
    const wj = await who.json();
    const email = wj.users && wj.users[0] && wj.users[0].email;
    if (!who.ok || !email) return json({ error: 'invalid sign in' }, 401);

    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT), pid = sa.project_id;
    const at = await accessToken(sa, f);
    const auth = { authorization: 'Bearer ' + at };
    const base = 'https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents';

    /* must be an admin */
    const adm = await f(base + '/admins/' + encodeURIComponent(email.toLowerCase()), { headers: auth });
    if (!adm.ok) return json({ error: 'not an admin' }, 403);

    const req = await request.json().catch(() => ({}));
    const kind = req.kind === 'personal' ? 'personal' : req.kind === 'test' ? 'test' : 'announce';
    const now = Date.now();
    const jobs = []; /* { pid, title, body, url } */

    if (kind === 'test') {
      jobs.push({ pid: '', title: 'SNB পরীক্ষা', body: 'এই ডিভাইসে সার্ভার থেকে পুশ ঠিকমতো আসছে', url: './' });
    } else if (kind === 'announce') {
      const body = clip(req.body, 200); if (!body) return json({ error: 'empty message' }, 400);
      jobs.push({ pid: '', title: clip(req.title, 80) || 'SNB ঘোষণা', body, url: clip(req.url, 200) || './' });
    } else if (kind === 'personal') {
      (Array.isArray(req.items) ? req.items : []).slice(0, 12).forEach((it) => {
        const body = clip(it && it.body, 200), p = clip(it && it.pid, 60);
        if (body && p) jobs.push({ pid: p, title: clip(it.title, 80) || 'SNB', body, url: clip(it.url, 200) || './' });
      });
      if (!jobs.length) return json({ error: 'empty message' }, 400);
    }

    /* device tokens */
    let tokens = [];
    if (kind === 'test') {
      const t = clip(req.token, 600); if (!t) return json({ error: 'no token' }, 400);
      tokens = [{ token: t, pid: '', name: '' }];
    } else {
      const lr = await f(base + '/pushTokens?pageSize=100&orderBy=ts%20desc', { headers: auth });
      const lj = await lr.json();
      tokens = (lj.documents || []).filter((d) => d.fields && d.fields.token && d.fields.token.stringValue).map((d) => ({
        name: d.name, token: d.fields.token.stringValue, pid: (d.fields.pid && d.fields.pid.stringValue) || ''
      }));
    }

    /* save the notifications so the site can list them */
    let saved = 0;
    if (kind !== 'test') {
      const writes = jobs.map((j, i) => ({
        update: {
          name: 'projects/' + pid + '/databases/(default)/documents/notifications/' + now.toString(36) + i + Math.random().toString(36).slice(2, 6),
          fields: { kind: fv(kind), pid: fv(j.pid), title: fv(j.title), body: fv(j.body), url: fv(j.url), ts: fv(now) }
        }
      }));
      const cr = await f(base + ':commit', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ writes }) });
      if (cr.ok) saved = writes.length;
    }

    /* push */
    let sent = 0, failed = 0, removed = 0, devices = 0;
    const errors = [];
    const sends = [];
    jobs.forEach((j, ji) => {
      const targets = kind === 'test' ? tokens : j.pid ? tokens.filter((t) => t.pid === j.pid).slice(0, 3) : tokens.slice(0, 38);
      targets.forEach((t) => sends.push({ t, j, tag: (j.pid ? 'snb-' + j.pid : 'snb-all') + '-' + now + '-' + ji }));
    });
    devices = sends.length;
    const room = Math.max(0, MAX_REQ - used - 1);
    await Promise.all(sends.slice(0, room).map(async (s) => {
      const r = await f('https://fcm.googleapis.com/v1/projects/' + pid + '/messages:send', {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token: s.t.token, data: { title: s.j.title, body: s.j.body, url: s.j.url, tag: s.tag }, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } })
      });
      if (r.ok) { sent++; return; }
      failed++;
      const txt = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
      if (errors.length < 3) errors.push(r.status + ' ' + txt);
      if ((r.status === 404 || r.status === 400) && s.t.name && used < MAX_REQ + 1) {
        const del = await f('https://firestore.googleapis.com/v1/' + s.t.name, { method: 'DELETE', headers: auth });
        if (del.ok) removed++;
      }
    }));
    return json({ sent, failed, removed, devices, saved, skipped: Math.max(0, sends.length - room), errors });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}
