// Proxies browser requests to the Hugging Face Inference API so HF_TOKEN never reaches the
// client. Body: { endpoint: "zero-shot" | "embedding", payload: { model, ...rest } }
// `model` picks which HF model to call; everything else in `payload` is forwarded verbatim as
// the HF Inference API request body (e.g. `inputs`, `parameters` for zero-shot classification).
// Same shared-secret pattern as netlify/functions/groq.js — see that file's comment for why this
// only raises the bar rather than being a true secret, and why it fails open until configured.
// The only two models the app actually calls — locking to this allowlist means the shared
// secret leaking (it's visible in page source by design, see comment below) can't be used to
// turn this into a free general-purpose gateway to arbitrary Hugging Face models on our token.
const ALLOWED_MODELS = new Set([
  'MoritzLaurer/mDeBERTa-v3-base-mnli-xnli', // zero-shot classification
  'intfloat/multilingual-e5-large'           // sentence embedding
]);
// A transcript is capped at 5000 chars at the Firestore layer (see firestore.rules) — this
// mirrors that so oversized text can't be pushed through the classifier/embedding models either.
const MAX_INPUT_CHARS = 5000;
const MAX_BODY_BYTES = 200 * 1024;

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

  const apiKey = process.env.HF_TOKEN;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'HF_TOKEN not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { endpoint, payload } = body;
  if (endpoint !== 'zero-shot' && endpoint !== 'embedding') {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid endpoint' }) };
  }

  const { model, ...hfBody } = payload || {};
  if (!model) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing model' }) };
  }
  if (!ALLOWED_MODELS.has(model)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Model not allowed' }) };
  }
  if (typeof hfBody.inputs === 'string' && hfBody.inputs.length > MAX_INPUT_CHARS) {
    return { statusCode: 413, body: JSON.stringify({ error: 'Input too long' }) };
  }

  try {
    // api-inference.huggingface.co was retired when HF moved to "Inference Providers" — the
    // same free serverless inference now lives behind this router, under the hf-inference
    // provider name (confirmed by direct testing; request/response shape is unchanged).
    const res = await fetch(`https://router.huggingface.co/hf-inference/models/${model}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(hfBody)
    });

    const data = await res.json();
    return {
      statusCode: res.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: 'HF Inference request failed', detail: String(err) }) };
  }
};
