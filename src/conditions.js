const KEY = /^[a-zA-Z0-9_]{1,40}$/;
const NAME = /^[a-zA-Z0-9_ ]{1,40}$/;
const LIMIT = 40;
const finite = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
const label = value => typeof value === 'string' && NAME.test(value) ? value : null;

// Active conditions (character.s): only whitelisted fields leave the server.
// `from` is who cast it, `count`/`target` describe a monster hunt, `intensity` a burn.
export function conditionsView(s) {
  if (!s || typeof s !== 'object') return [];
  return Object.entries(s).filter(([key, value]) => KEY.test(key) && value && typeof value === 'object').slice(0, LIMIT).map(([key, value]) => ({
    key, ms: finite(value.ms), from: label(value.f), count: finite(value.c), target: label(value.id), intensity: finite(value.intensity),
  })).sort((a, b) => a.key.localeCompare(b.key));
}

// Game definitions of conditions reduced to a display name, its kind and the game's explanation.
export function conditionDefinitions(conditions) {
  const result = {};
  for (const [key, definition] of Object.entries(conditions && typeof conditions === 'object' ? conditions : {})) {
    if (!KEY.test(key) || !definition || typeof definition !== 'object') continue;
    const kind = definition.debuff || definition.bad ? 'debuff' : definition.buff ? 'buff' : 'neutral';
    result[key] = {
      name: typeof definition.name === 'string' && definition.name.length <= 80 ? definition.name : key, kind,
      explanation: typeof definition.explanation === 'string' ? definition.explanation.slice(0, 300) : '',
    };
  }
  return result;
}
