export const PREFERENCE_KEY = 'predictir:appearance:v1';
export const THEMES = {
  graphite: {name: 'Black', description: 'Near-black with quiet gray surfaces', panel: '#0a0a0a', ink: '#ededed', muted: '#a1a1a1', accent: '#ededed'},
  midnight: {name: 'Charcoal', description: 'Soft neutral gray for longer sessions', panel: '#141414', ink: '#ededed', muted: '#ababab', accent: '#ededed'},
  light: {name: 'Light', description: 'Paper white for bright rooms', panel: '#ffffff', ink: '#171717', muted: '#606060', accent: '#262626'},
};

const layouts = ['balanced', 'analysis', 'wide-list'] as const;
const densities = ['comfortable', 'compact'] as const;
const models = ['validated', 'challenger'] as const;
type Theme = keyof typeof THEMES;
export type ModelPreference = typeof models[number];
export type AppearancePreferences = {
  theme: Theme;
  layout: typeof layouts[number];
  density: typeof densities[number];
  model: ModelPreference;
};
export const DEFAULT_PREFERENCES: Readonly<AppearancePreferences> = Object.freeze({
  theme: 'graphite', layout: 'balanced', density: 'comfortable', model: 'validated'
});

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && Object.hasOwn(THEMES, value);
}

function isChoice<T extends string>(options: readonly T[], value: unknown): value is T {
  return options.some(option => option === value);
}

export function appearance(value: unknown): AppearancePreferences {
  let data = value;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); }
    catch { data = null; }
  }
  if (!data || typeof data !== 'object') return {...DEFAULT_PREFERENCES};
  const theme = 'theme' in data ? data.theme : null;
  const layout = 'layout' in data ? data.layout : null;
  const density = 'density' in data ? data.density : null;
  const model = 'model' in data ? data.model : null;
  return {
    theme: isTheme(theme) ? theme : DEFAULT_PREFERENCES.theme,
    layout: isChoice(layouts, layout) ? layout : DEFAULT_PREFERENCES.layout,
    density: isChoice(densities, density) ? density : DEFAULT_PREFERENCES.density,
    model: isChoice(models, model) ? model : DEFAULT_PREFERENCES.model,
  };
}

export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    if (!/^#[a-f\d]{6}$/i.test(hex)) throw new RangeError('Six-digit colors are required');
    const channels = [1, 3, 5]
      .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
