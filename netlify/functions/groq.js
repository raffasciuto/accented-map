// Proxies browser requests to the Groq API (Whisper transcription only) so GROQ_API_KEY never
// reaches the client. Body: { endpoint: "transcriptions", payload }
// The payload carries the audio as base64 (JSON has no multipart), which this function decodes
// back into a real file before forwarding as multipart/form-data to Groq.
// Shared-secret check: raises the bar against scripts hitting this endpoint blind (the URL is
// visible in the page's own source, so this can't be a true secret against someone who actually
// loads the page and inspects requests — the real backstop against a surprise bill is a spending
// limit set on the Groq account itself). Only enforced once APP_SHARED_SECRET is configured in
// Netlify, so deploying this doesn't break the app before that env var is set.
// Recording is transcribed in ~4s segments (see index.html detectLanguageFromSegments), so a
// legitimate request's base64 payload is small — this caps well above that with headroom while
// still bounding what a direct-call abuser could push through per request.
const MAX_BODY_BYTES = 3 * 1024 * 1024;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if ((event.body || '').length > MAX_BODY_BYTES) {
    return { statusCode: 413, body: JSON.stringify({ error: 'Payload too large' }) };
  }

  const sharedSecret = process.env.APP_SHARED_SECRET;
  if (sharedSecret && event.headers['x-app-secret'] !== sharedSecret) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { endpoint, payload } = body;
  if (endpoint !== 'transcriptions') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid endpoint' }) };
  }

  try {
    const { audioBase64, filename, response_format } = payload || {};
    if (!audioBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing audioBase64' }) };
    }
    const form = new FormData();
    form.append('file', new Blob([Buffer.from(audioBase64, 'base64')]), filename || 'audio.webm');
    // Locked to whisper-large-v3 rather than trusting a client-supplied model name — this proxy
    // exists only to transcribe, not to be a general-purpose gateway to any Groq model.
    form.append('model', 'whisper-large-v3');
    form.append('response_format', response_format || 'verbose_json');

    const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });

    const data = await res.json();
    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: 'Groq request failed', detail: String(err) }) };
  }
};
