// netlify/functions/analyze-sheet.js
//
// Función serverless de Netlify. El navegador (admin.html / index.html) le
// envía una foto de la planilla del partido; esta función llama a la API
// gratuita de Google Gemini usando la llave secreta GEMINI_API_KEY guardada
// como variable de entorno en Netlify (nunca en el código ni en el
// navegador), y devuelve goles, tarjetas y resultado en JSON.
//
// CONFIGURACIÓN NECESARIA EN NETLIFY (una sola vez):
//   1. Entra a https://aistudio.google.com/apikey (Google AI Studio) e
//      inicia sesión con una cuenta de Google. No pide tarjeta.
//   2. Clic en "Create API key" y cópiala (empieza con "AIza...").
//   3. En Netlify: Site settings → Environment variables → Add a variable
//      Key:   GEMINI_API_KEY
//      Value: (tu llave)
//   4. Vuelve a desplegar el sitio (Deploys → Trigger deploy) para que la
//      función pueda leer la variable.
//
// El plan gratuito de Gemini Flash tiene un límite de usos por día (varía
// según el modelo y puede cambiar sin aviso de parte de Google). Si algún
// día ese límite se agota, la función devuelve un error claro y el resto
// de la página sigue funcionando normal — solo hay que esperar al día
// siguiente o subir de plan en Google AI Studio.
//
// Si en el futuro Google retira el modelo usado aquí, solo hace falta
// cambiar GEMINI_MODEL (ver más abajo) — no hace falta tocar el resto del
// código. También se puede fijar un modelo distinto sin editar el archivo
// agregando una variable de entorno GEMINI_MODEL en Netlify.
//
// Esta función NO guarda nada por sí sola: solo lee la imagen y devuelve
// texto/JSON. El guardado real (goles, tarjetas, resultado) solo ocurre
// cuando el admin revisa y confirma en la página, como con cualquier otro
// resultado del sistema.

const DEFAULT_MODEL = 'gemini-3.5-flash'; // modelo gratuito con visión, ago-2026
const GEMINI_MODEL = process.env.GEMINI_MODEL || DEFAULT_MODEL;

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Método no permitido' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({
        error: 'Falta configurar GEMINI_API_KEY en Netlify (Site settings → Environment variables) y volver a desplegar el sitio.',
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'JSON inválido en la solicitud.' }) };
  }

  const { imageBase64, mediaType, teamA, teamB, disc, cat, rosterA, rosterB } = payload;
  if (!imageBase64 || !mediaType) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Falta la imagen de la planilla.' }) };
  }
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowedTypes.includes(mediaType)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Formato de imagen no soportado. Usa JPG, PNG o WEBP.' }) };
  }
  // Límite generoso de tamaño (base64 ~ 1.37x el tamaño real)
  if (imageBase64.length > 20_000_000) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'La foto es demasiado pesada. Intenta con una foto más liviana.' }) };
  }

  const prompt = `Eres un asistente que lee planillas oficiales de partidos escolares (fútbol, voleibol, baloncesto, etc.), normalmente escritas a mano, a partir de una foto.

Partido: "${teamA}" vs "${teamB}" — ${disc || ''} · ${cat || ''}
Jugadores conocidos de "${teamA}": ${(rosterA && rosterA.length) ? rosterA.join(', ') : '(sin nómina registrada)'}
Jugadores conocidos de "${teamB}": ${(rosterB && rosterB.length) ? rosterB.join(', ') : '(sin nómina registrada)'}

Analiza la imagen adjunta y extrae la información en un JSON con EXACTAMENTE esta forma, sin texto antes ni después, sin bloques de código:

{
  "scoreA": <número entero o null si no se ve>,
  "scoreB": <número entero o null si no se ve>,
  "goalsA": [{"player": "NOMBRE EN MAYÚSCULA", "autogol": false}],
  "goalsB": [{"player": "NOMBRE EN MAYÚSCULA", "autogol": false}],
  "cardsA": [{"player": "NOMBRE EN MAYÚSCULA", "type": "amarilla"}],
  "cardsB": [{"player": "NOMBRE EN MAYÚSCULA", "type": "amarilla o roja"}],
  "notes": "cualquier duda, letra ilegible o inconsistencia que el admin deba revisar; deja vacío si no hay ninguna"
}

Reglas:
- "goalsA" y "cardsA" son del equipo "${teamA}"; "goalsB"/"cardsB" son del equipo "${teamB}".
- Compara cada nombre manuscrito con la lista de jugadores conocidos de ese equipo y usa la versión correcta de la lista si se parece razonablemente (corrige errores de escritura o abreviaciones obvias). Si el nombre no se parece a ninguno conocido, escribe tal cual lo leas, en mayúscula.
- Si un gol es autogol, "player" puede ir null y "autogol" en true.
- Si no puedes leer el marcador o algún dato con confianza, dilo en "notes" en vez de inventarlo (usa null en ese caso).
- Responde SOLO con el JSON, nada más.`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mediaType, data: imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = (data && data.error && data.error.message) || 'Error llamando a la API de Gemini.';
      const quota = geminiRes.status === 429 || /quota|rate.?limit|resource.?exhausted/i.test(msg);
      return {
        statusCode: geminiRes.status,
        headers: cors,
        body: JSON.stringify({
          error: quota
            ? 'Se agotó el límite gratuito de usos de hoy. Vuelve a intentarlo más tarde o mañana.'
            : msg,
        }),
      };
    }

    const candidate = (data.candidates && data.candidates[0]) || {};
    const text = ((candidate.content && candidate.content.parts) || [])
      .map((p) => p.text || '')
      .join('\n')
      .trim();

    if (!text) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ error: 'La IA no devolvió ningún texto. Intenta con una foto más clara.', raw: JSON.stringify(data).slice(0, 500) }),
      };
    }

    const cleaned = text.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({ error: 'La IA no devolvió un JSON válido. Intenta con una foto más clara.', raw: text }),
      };
    }

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(parsed) };
  } catch (e) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'No se pudo conectar con la API de Gemini: ' + e.message }),
    };
  }
};
