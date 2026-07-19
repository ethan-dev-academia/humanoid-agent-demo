/**
 * Provider wiring for the demo. OpenRouter for the one LLM call on the
 * critical path; Xenova/transformers for embeddings so no second API key
 * is required.
 *
 * Both functions match the SDK's Generate / Embed type signatures — plug
 * them straight into `AgentConfig.models.generation`.
 */

import type { Embedding } from '@humanoid/types';

export interface OpenRouterChatOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Site URL for OpenRouter's referrer tracking. Optional. */
  readonly site?: string;
  /** App name for OpenRouter's usage dashboard. Optional. */
  readonly appName?: string;
}

/**
 * Build a `generate` function that posts to OpenRouter's chat completions
 * endpoint. Returns the assistant reply as a plain string.
 */
export function createOpenRouterChat(opts: OpenRouterChatOptions): (prompt: string) => Promise<string> {
  const url = 'https://openrouter.ai/api/v1/chat/completions';
  return async (prompt: string): Promise<string> => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
        ...(opts.site !== undefined ? { 'HTTP-Referer': opts.site } : {}),
        ...(opts.appName !== undefined ? { 'X-Title': opts.appName } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${body}`);
    }
    const data = (await res.json()) as {
      choices?: readonly { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(`OpenRouter returned no content: ${JSON.stringify(data)}`);
    }
    return content;
  };
}

/**
 * Build an `embed` function backed by a local Xenova/transformers pipeline.
 * First call downloads ~30MB of ONNX model weights; subsequent calls are fast
 * and offline. Returns a 384-dim embedding (Xenova/all-MiniLM-L6-v2).
 *
 * Cosine-trained, so it plays well with the SDK's manifold-hygiene
 * L2-normalization on μ_p and a_ant.
 */
export async function createXenovaEmbed(): Promise<(text: string) => Promise<Embedding>> {
  // Dynamic import so the (large) transformers package is only loaded when
  // this function is actually called — keeps `tsx` startup snappy for
  // command-only invocations (`--help`, etc.) if we ever add them.
  const { pipeline } = await import('@xenova/transformers');
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  return async (text: string): Promise<Embedding> => {
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    // `output.data` is a Float32Array of length 384 for MiniLM-L6.
    return Array.from(output.data as Float32Array);
  };
}

/** Embedding dimensionality of the default Xenova model. */
export const XENOVA_EMBEDDING_DIM = 384;
