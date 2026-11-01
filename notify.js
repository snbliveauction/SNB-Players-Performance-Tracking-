/* Cloudflare Pages Function: POST /api/notify
   Admin (signed in with Firebase) -> sends a push to every saved device token.
   Secrets (Pages > Settings > Variables and Secrets):
     FIREBASE_SERVICE_ACCOUNT  the whole service-account JSON
     FIREBASE_API_KEY          the web apiKey from config.js
   Free plan allows 50 outgoing requests per call (4 are used for checks), so at most MAX_DEVICES devices get a push per call. */
const MAX_DEVICES = 40;
const enc = new TextEncoder();
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

function b64u(buf) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function accessToken(sa) {
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
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' + head + '.' + claim + '.' + b64u(sig)
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('oauth failed');
  return j.access_token;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.FIREBASE_SERVICE_ACCOUNT || !env.FIREBASE_API_KEY) return json({ error: 'server not configured' }, 500);
    const idToken = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!idToken) return json({ error: 'sign in required' }, 401);

    /* 1. who is calling? */
    const who = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(env.FIREBASE_API_KEY), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken })
    });
    const wj = await who.json();
    const email = wj.users && wj.users[0] && wj.users[0].email;
    if (!who.ok || !email) return json({ error: 'invalid sign in' }, 401);

    const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT), pid = sa.project_id;
    const at = await accessToken(sa);
    const auth = { authorization: 'Bearer ' + at };
    const base = 'https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents';

    /* 2. must be in the admins collection */
    const adm = await fetch(base + '/admins/' + encodeURIComponent(email.toLowerCase()), { headers: auth });
    if (!adm.ok) return json({ error: 'not an admin' }, 403);

    /* 3. message */
    const body = await request.json().catch(() => ({}));
    const title = String(body.title || 'SNB').slice(0, 80), text = String(body.body || '').slice(0, 200);
    if (!text) return json({ error: 'empty message' }, 400);
    const url = String(body.url || './').slice(0, 200);

    /* 4. device tokens (newest first) */
    const lr = await fetch(base + '/pushTokens?pageSize=' + MAX_DEVICES + '&orderBy=ts%20desc', { headers: auth });
    const lj = await lr.json();
    const docs = (lj.documents || []).filter((d) => d.fields && d.fields.token && d.fields.token.stringValue);

    /* 5. send */
    let sent = 0, failed = 0, removed = 0;
    await Promise.all(docs.map(async (d) => {
      const token = d.fields.token.stringValue;
      const r = await fetch('https://fcm.googleapis.com/v1/projects/' + pid + '/messages:send', {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { token, data: { title, body: text, url, tag: 'snb-' + Date.now() }, webpush: { headers: { Urgency: 'high', TTL: '3600' } } } })
      });
      if (r.ok) { sent++; return; }
      failed++;
      if (r.status === 404 || r.status === 400) { /* token is dead: forget it */
        const del = await fetch('https://firestore.googleapis.com/v1/' + d.name, { method: 'DELETE', headers: auth });
        if (del.ok) removed++;
      }
    }));
    return json({ sent, failed, removed, devices: docs.length });
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 500);
  }
}
