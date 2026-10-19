// Server-only: the phone pairs with openGym; only the backend holds the gym bridge token.
export const OPENCLAW_PROVIDER = Object.freeze({
  label: 'OpenClaw gym coach', runtime: 'HTTP bridge', http: true,
  apiKeyEnv: 'OPENCLAW_COACH_TOKEN', oauthEnv: null,
  baseUrl: true, defaultBase: null, defaultModel: 'openclaw/gym-coach',
  keyPlaceholder: 'Gym bridge token (not the OpenClaw gateway token)'
});

export const validCoachProfile = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
export const validCoachPersona = value => typeof value === 'string' && /^openclaw\/[A-Za-z0-9_-]{1,64}$/.test(value);
export const OPENCLAW_ACCOUNT_REFUSAL =
  'The OpenClaw gym coach is bound to one training profile. Ask your admin to check its MCP profile binding.';
