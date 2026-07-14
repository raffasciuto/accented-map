// Proxies browser requests to the Groq API so GROQ_API_KEY never reaches the client.
// Body: { endpoint: "transcriptions" | "chat/completions", payload }
// "transcriptions" payload carries the audio as base64 (JSON has no multipart), which this
// function decodes back into a real file before forwarding as multipart/form-data to Groq.
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
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
  if (endpoint !== 'transcriptions' && endpoint !== 'chat/completions') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid endpoint' }) };
  }

  try {
    let res;
    if (endpoint === 'transcriptions') {
      const { audioBase64, filename, model, response_format } = payload || {};
      if (!audioBase64) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing audioBase64' }) };
      }
      const form = new FormData();
      form.append('file', new Blob([Buffer.from(audioBase64, 'base64')]), filename || 'audio.webm');
      form.append('model', model || 'whisper-large-v3');
      form.append('response_format', response_format || 'verbose_json');

      res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form
      });
    } else {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });
    }

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
