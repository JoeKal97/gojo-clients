const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GC_API_KEY = process.env.GC_API_KEY;
const GC_BASE_URL = process.env.GC_BASE_URL || 'https://api.globalcontrol.io/api/ai';

const CORS = {
  'Access-Control-Allow-Origin': 'https://www.gojoagency.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function setCors(res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
}

async function gcRequest(path, options = {}) {
  const method = options.method || 'GET';
  const headers = { 'X-API-KEY': GC_API_KEY, ...(options.headers || {}) };
  if (method !== 'GET' && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${GC_BASE_URL}${path}`, {
    ...options,
    method,
    headers,
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { status: res.status, ok: res.ok, body };
}

function gcTagSuccess(body) {
  return Boolean(
    body?.type === 'response' &&
    body?.data?.type === 'response' &&
    body?.data?.data?._id
  );
}

async function getTagId(tagName) {
  try {
    const res = await gcRequest('/tags', { method: 'GET' });
    const tags = res.body?.data || res.body?.tags || [];
    const tag = tags.find(t => t.name === tagName || t.label === tagName);
    return tag?._id || tag?.id || null;
  } catch (e) {
    console.error('Tag lookup error:', e);
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  setCors(res);

  try {
    console.log('req.body:', JSON.stringify(req.body));
    const { firstName, lastName, email, phone } = req.body || {};
    const name = [firstName, lastName].filter(Boolean).join(' ') || 'Unknown';
    if (!email) return res.status(400).json({ error: 'Email required' });

    // 1. Log to Supabase
    let supabaseResult = null;
    try {
      const { data, error } = await supabase.from('contact_leads').insert([{
        name,
        email,
        phone: phone || null,
        source: 'gojoagency.com/contact'
      }]).select('*').single();
      if (error) throw error;
      supabaseResult = data;
    } catch (e) {
      console.error('Supabase error:', e);
    }

    // 2. Create GC contact
    let gcContactResult = null;
    try {
      const nameParts = name.trim().split(/\s+/);
      const gcPayload = {
        firstName: nameParts[0],
        lastName: nameParts.slice(1).join(' ') || '',
        email,
        phone: phone || undefined,
        source: 'GoJo Contact Form'
      };
      console.log('GC contact payload being sent:', JSON.stringify({
        firstName: nameParts[0],
        lastName: nameParts.slice(1).join(' ') || '',
        email,
        phone: phone || undefined,
        source: 'GoJo Contact Form'
      }));
      gcContactResult = await gcRequest('/contacts', {
        method: 'POST',
        body: JSON.stringify(gcPayload)
      });
      console.log('GC contact create raw response:', JSON.stringify(gcContactResult.body));
    } catch (e) {
      console.error('GC contact error:', e);
    }

    // 3. Dynamic tag lookup + fire by email
    let gcTagResult = null;
    try {
      const tagId = await getTagId('GJ_New_Lead');
      if (tagId) {
        gcTagResult = await gcRequest(`/tags/fire-tag/${tagId}`, {
          method: 'POST',
          body: JSON.stringify({ email })
        });
        if (!gcTagSuccess(gcTagResult.body)) {
          console.error('GC tag fire failed:', JSON.stringify(gcTagResult.body));
        }
      } else {
        console.error('GJ_New_Lead tag ID not found');
      }
    } catch (e) {
      console.error('GC tag error:', e);
    }

    // 4. Telegram notification
    let telegramResult = null;
    try {
      const text =
        `🔔 *New GoJo Lead*\n\n` +
        `*Name:* ${name}\n` +
        `*Email:* ${email}\n` +
        `*Phone:* ${phone || 'Not provided'}\n` +
        `*Submitted:* ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })} MT`;
      const tgRes = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          parse_mode: 'Markdown',
          text
        })
      });
      telegramResult = await tgRes.json().catch(() => ({}));
    } catch (e) {
      console.error('Telegram error:', e);
    }

    console.log('gojo-contact-notify success', JSON.stringify({
      email,
      supabaseRowId: supabaseResult?.id || null,
      gcContactOk: Boolean(gcContactResult?.ok),
      gcTagOk: gcTagSuccess(gcTagResult?.body),
      telegramOk: Boolean(telegramResult?.ok)
    }));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
};
