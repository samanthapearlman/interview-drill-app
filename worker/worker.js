const CORS_HEADERS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
});

function corsResponse(status, body, origin) {
  return new Response(body, {
    status,
    headers: {
      ...CORS_HEADERS(origin),
      'Content-Type': 'application/json',
    },
  });
}

function validateToken(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  return env.API_TOKEN && token === env.API_TOKEN;
}

const PRICING = {
  whisper_per_minute: 0.006,
  haiku_input_per_token: 0.0000008,
  haiku_output_per_token: 0.000004,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = env.ALLOWED_ORIGIN;

    if (request.method === 'OPTIONS') {
      if (origin === allowedOrigin) {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS(allowedOrigin),
        });
      }
      return new Response('Forbidden', { status: 403 });
    }

    if (origin !== allowedOrigin) {
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!validateToken(request, env)) {
      return corsResponse(403, JSON.stringify({ error: 'forbidden' }), allowedOrigin);
    }

    if (url.pathname === '/transcribe' && request.method === 'POST') {
      return handleTranscribe(request, env, allowedOrigin);
    }

    if (url.pathname === '/grade' && request.method === 'POST') {
      return handleGrade(request, env, allowedOrigin);
    }

    if (url.pathname === '/decks' && request.method === 'GET') {
      return handleGetDecks(request, env, allowedOrigin);
    }

    if (url.pathname === '/decks' && request.method === 'POST') {
      return handlePostDecks(request, env, allowedOrigin);
    }

    return corsResponse(
      404,
      JSON.stringify({ error: 'not_found' }),
      allowedOrigin,
    );
  },
};

async function handleGetDecks(request, env, allowedOrigin) {
  try {
    const raw = await env.INTERVIEW_DECKS.get('decks');
    if (!raw) {
      return corsResponse(200, JSON.stringify({ decks: [] }), allowedOrigin);
    }
    return corsResponse(200, raw, allowedOrigin);
  } catch (e) {
    console.error('handleGetDecks exception:', e);
    return corsResponse(
      500,
      JSON.stringify({ error: 'decks_load_failed', message: e.message }),
      allowedOrigin,
    );
  }
}

async function handlePostDecks(request, env, allowedOrigin) {
  try {
    const body = await request.json();
    if (!body || !Array.isArray(body.decks)) {
      return corsResponse(400, JSON.stringify({ error: 'invalid_body' }), allowedOrigin);
    }
    await env.INTERVIEW_DECKS.put('decks', JSON.stringify(body));
    return corsResponse(200, JSON.stringify({ ok: true }), allowedOrigin);
  } catch (e) {
    console.error('handlePostDecks exception:', e);
    return corsResponse(
      500,
      JSON.stringify({ error: 'decks_save_failed', message: e.message }),
      allowedOrigin,
    );
  }
}

async function handleTranscribe(request, env, allowedOrigin) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio');

    if (!audioFile) {
      return corsResponse(
        400,
        JSON.stringify({ error: 'missing_audio' }),
        allowedOrigin,
      );
    }

    const mimeType = audioFile.type || 'audio/mp4';
    const filename =
      mimeType.includes('mp4') || mimeType.includes('aac')
        ? 'recording.mp4'
        : 'recording.webm';

    const whisperForm = new FormData();
    whisperForm.append('file', audioFile, filename);
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('language', 'en');

    const whisperRes = await fetch(
      'https://api.openai.com/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: whisperForm,
      },
    );

    if (!whisperRes.ok) {
      const err = await whisperRes.text();
      console.error('Whisper error:', whisperRes.status, err);
      return corsResponse(
        502,
        JSON.stringify({
          error: 'transcription_failed',
          message: 'Whisper API error',
        }),
        allowedOrigin,
      );
    }

    const result = await whisperRes.json();
    const durationSec = result.duration || 0;
    const cost = {
      service: 'whisper',
      amount: Math.round((durationSec / 60) * PRICING.whisper_per_minute * 1000000) / 1000000,
      unit: 'usd',
      duration_sec: durationSec,
    };

    return corsResponse(
      200,
      JSON.stringify({ transcript: result.text, cost }),
      allowedOrigin,
    );
  } catch (e) {
    console.error('handleTranscribe exception:', e);
    return corsResponse(
      500,
      JSON.stringify({ error: 'transcription_failed', message: e.message }),
      allowedOrigin,
    );
  }
}

async function handleGrade(request, env, allowedOrigin) {
  try {
    const body = await request.json();
    const { transcript, prompt, target, keyPoints } = body;

    if (!transcript || !prompt || !target || !keyPoints) {
      return corsResponse(
        400,
        JSON.stringify({ error: 'missing_fields' }),
        allowedOrigin,
      );
    }

    const gradingPrompt = `You are an interview coach grading a practice response.

PROMPT: ${prompt}

TARGET TALKING POINT:
${target}

KEY POINTS TO HIT:
${keyPoints.join('\n')}

CANDIDATE RESPONSE:
${transcript}

Grade this response. Return JSON only, no other text:
{
  "score": <1-10 integer>,
  "callouts": [
    "Good: <specific observation>",
    "Weak: <specific observation>",
    "Missing: <specific observation if applicable>"
  ]
}

Rules:
- Score 9-10: hit all key points, strong delivery, clear landing
- Score 7-8: hit most key points, minor gaps or delivery issues
- Score 5-6: hit some key points, clear gaps
- Score below 5: missed key points or significant delivery problems
- Callouts must be specific to THIS response, not generic coaching advice
- 2-3 callouts max
- Include a "Good" callout when a key point was hit clearly
- Include a "Weak" callout if delivery trailed off, ran too long, or lacked a landing
- Include a "Missing" callout only if a key point was completely absent from the response
- keyPoints are the primary scoring criteria; target text provides full context`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: gradingPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.text();
      console.error('Claude error:', claudeRes.status, err);
      return corsResponse(
        502,
        JSON.stringify({ error: 'grading_failed', message: 'Claude API error' }),
        allowedOrigin,
      );
    }

    const claudeData = await claudeRes.json();
    const rawText = claudeData.content[0].text.trim();

    let gradeResult;

    try {
      gradeResult = JSON.parse(rawText);
    } catch (parseErr) {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        try {
          gradeResult = JSON.parse(jsonMatch[0]);
        } catch {
          console.error('Failed to parse Claude JSON:', rawText);
          return corsResponse(
            502,
            JSON.stringify({
              error: 'grading_failed',
              message: 'Malformed response',
            }),
            allowedOrigin,
          );
        }
      } else {
        console.error('No JSON in Claude response:', rawText);
        return corsResponse(
          502,
          JSON.stringify({
            error: 'grading_failed',
            message: 'Malformed response',
          }),
          allowedOrigin,
        );
      }
    }

    if (
      typeof gradeResult.score !== 'number' ||
      !Array.isArray(gradeResult.callouts)
    ) {
      return corsResponse(
        502,
        JSON.stringify({
          error: 'grading_failed',
          message: 'Invalid grade shape',
        }),
        allowedOrigin,
      );
    }

    const usage = claudeData.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cost = {
      service: 'haiku',
      amount: Math.round((inputTokens * PRICING.haiku_input_per_token + outputTokens * PRICING.haiku_output_per_token) * 1000000) / 1000000,
      unit: 'usd',
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    };

    return corsResponse(
      200,
      JSON.stringify({
        score: gradeResult.score,
        callouts: gradeResult.callouts,
        cost,
      }),
      allowedOrigin,
    );
  } catch (e) {
    console.error('handleGrade exception:', e);
    return corsResponse(
      500,
      JSON.stringify({ error: 'grading_failed', message: e.message }),
      allowedOrigin,
    );
  }
}
