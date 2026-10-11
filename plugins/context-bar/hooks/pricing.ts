// Anthropic first-party API list prices, USD per million tokens (cached 2026-10-06).
// Cache writes are priced from `input` (1.25x for a 5-minute TTL, 2x for 1 hour).
// Bedrock and Vertex price separately, and subscription plans are not billed per
// token, so every figure the bar shows is an estimate at these rates.

export type Price = {
  input: number
  output: number
  cacheRead: number
  /** Haiku 5.5 charges more once a prompt passes 100K tokens. */
  longContext?: { aboveTokens: number; input: number; output: number; cacheRead: number }
}

export type CacheTtl = '5m' | '1h'

const PRICES: ReadonlyArray<readonly [string, Price]> = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-mythos-5-1', { input: 10, output: 50, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheRead: 0.5 }],
  ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheRead: 0.2 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3 }],
  [
    'claude-haiku-5-5',
    {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 },
    },
  ],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheRead: 0.1 }],
]

// What an unrecognised id falls back to, by family.
const FAMILY: ReadonlyArray<readonly [string, string]> = [
  ['fable', 'claude-fable-5-1'],
  ['mythos', 'claude-mythos-5-1'],
  ['opus', 'claude-opus-5-5'],
  ['sonnet', 'claude-sonnet-5-5'],
  ['haiku', 'claude-haiku-5-5'],
]

/**
 * Turns an API id (`claude-opus-5-5[1m]`, `anthropic.claude-sonnet-5-5`) or a
 * display name (`Opus 5.5`) into the table's spelling.
 */
export function normalizeModel(model: string): string {
  let id = model
    .toLowerCase()
    .replace(/\[.*?\]/g, '')
    .replace(/^.*?(claude)/, '$1')
    .replace(/@.*$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/[\s.]+/g, '-')
    .replace(/-+$/, '')
  if (!id.startsWith('claude-')) id = `claude-${id}`
  return id
}

export function priceFor(model: string): Price {
  const id = normalizeModel(model)
  // Longest key first so `claude-opus-5-5` wins over `claude-opus-5`.
  const exact = [...PRICES]
    .sort((a, b) => b[0].length - a[0].length)
    .find(([key]) => id === key || id.startsWith(`${key}-`))
  if (exact) return exact[1]
  const family = FAMILY.find(([word]) => id.includes(word))
  const fallback = family ? PRICES.find(([key]) => key === family[1]) : undefined
  return (fallback ?? PRICES.find(([key]) => key === 'claude-opus-5-5')!)[1]
}

export function writeMultiplier(ttl: CacheTtl): number {
  return ttl === '1h' ? 2 : 1.25
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function tierFor(price: Price, promptTokens: number) {
  const long = price.longContext
  return long && promptTokens > long.aboveTokens ? long : price
}

/** Estimated USD for one request's usage. */
export function usageUsd(model: string, usage: Usage, ttl: CacheTtl): number {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const rate = tierFor(priceFor(model), prompt)
  return (
    (usage.input_tokens * rate.input +
      usage.cache_creation_input_tokens * rate.input * writeMultiplier(ttl) +
      usage.cache_read_input_tokens * rate.cacheRead +
      usage.output_tokens * rate.output) /
    1_000_000
  )
}

/**
 * A request's cache writes at the plain input rate, before the TTL's multiplier:
 * kept per loop so its cost can be re-priced once the loop's real TTL is known.
 */
export function writeBaseUsd(model: string, usage: Usage): number {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  return (usage.cache_creation_input_tokens * tierFor(priceFor(model), prompt).input) / 1_000_000
}

/** USD to send `tokens` of context once: read from a warm cache, or written to a cold one. */
export function contextUsd(model: string, tokens: number, ttl: CacheTtl): { warm: number; cold: number } {
  const rate = tierFor(priceFor(model), tokens)
  return {
    warm: (tokens * rate.cacheRead) / 1_000_000,
    cold: (tokens * rate.input * writeMultiplier(ttl)) / 1_000_000,
  }
}
