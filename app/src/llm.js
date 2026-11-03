// Bring-your-own-key LLM client for the tutor. Requests go straight from the browser to the provider you pick;
// the key is kept in this browser's localStorage and is never sent anywhere else.
export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', base: 'https://api.anthropic.com/v1', model: 'claude-haiku-5-5', kind: 'anthropic' },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', kind: 'openai' },
  gemini: { label: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', kind: 'openai' },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', kind: 'openai' },
  custom: { label: 'Custom (OpenAI-compatible)', base: 'http://localhost:11434/v1', model: '', kind: 'openai' },
};
const KEY = 'augur:llm';
const DEFAULT = { provider: 'anthropic', key: '', model: '', base: '' };

export function loadLLM() {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULT }; }
}
export function saveLLM(cfg) { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* private mode */ } }
export function clearLLM() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
/** A key is optional for a local custom endpoint (Ollama, LM Studio…). */
export function llmReady(cfg = loadLLM()) { return cfg.provider === 'custom' ? !!(cfg.base || PROVIDERS.custom.base) && !!cfg.model : !!cfg.key.trim(); }

function resolve(cfg) {
  const p = PROVIDERS[cfg.provider] || PROVIDERS.anthropic;
  return { kind: p.kind, base: (cfg.base || p.base).replace(/\/+$/, ''), model: cfg.model || p.model, key: cfg.key.trim(), provider: cfg.provider };
}

/** One-shot completion. Throws Error with a user-readable message. */
export async function ask({ system, user, maxTokens = 450, signal }, cfg = loadLLM()) {
  const r = resolve(cfg);
  if (!r.model) throw new Error('Choose a model in Settings.');
  let res;
  try {
    if (r.kind === 'anthropic') {
      res = await fetch(r.base + '/messages', {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': r.key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: r.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      });
    } else {
      const headers = { 'content-type': 'application/json' };
      if (r.key) headers.authorization = 'Bearer ' + r.key;
      res = await fetch(r.base + '/chat/completions', {
        method: 'POST', signal, headers,
        body: JSON.stringify({ model: r.model, [r.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
    }
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('Could not reach the provider — check your connection (and the base URL for custom endpoints).');
  }
  let data = null; try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || res.statusText;
    if (res.status === 401 || res.status === 403) throw new Error('The provider rejected your API key. ' + (msg || ''));
    if (res.status === 429) throw new Error('Rate limited by the provider — try again in a moment.');
    throw new Error(`Provider error ${res.status}: ${msg || 'unknown'}`);
  }
  const text = r.kind === 'anthropic' ? data?.content?.filter(b => b.type === 'text').map(b => b.text).join('') : data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('The model returned an empty reply.');
  return text.trim();
}

export const TUTOR_SYSTEM = `You are a warm, concise chess tutor sitting next to a student during a game.
You are given the position, the move just played, and verified Stockfish analysis. Treat the engine data as ground truth: never invent evaluations, never suggest moves that are not in the data.
Explain in plain English, 2-4 short sentences, no headings and no bullet points. Say WHY the move is good or bad (threats, tactics, king safety, development, pawn structure, piece activity), mention what the opponent can now do, and if the move was weak say what the engine's better move achieves instead. Use the move names exactly as given. Do not mention "centipawns" or "win percentage"; speak in terms of "slightly better", "clearly winning", "equal" etc.`;
