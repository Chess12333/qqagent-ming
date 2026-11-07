/**
 * Emotion's activity levels are defaults, while `ramp`, `posRamp`, and
 * `halfLifeMul` are legacy explicit overrides. config-store.get() returns the
 * merged view, so passing it directly makes default values look explicit and
 * masks the levels. Keep the module API unchanged; adapt only the config view
 * supplied to the emotion owner, using raw config to preserve real overrides.
 */
const OVERRIDE_KEYS = Object.freeze(['ramp', 'posRamp', 'halfLifeMul']);

export function createEmotionConfigStore(configStore) {
  return Object.freeze({
    get(keyPath, fallback) {
      let value;
      try { value = configStore?.get?.(keyPath, fallback); } catch { return fallback; }
      if (keyPath !== 'emotion') return value;

      const merged = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      let rawEmotion = {};
      let rawKnown = false;
      try {
        const snapshot = configStore?.snapshot?.();
        if (snapshot && snapshot.raw && typeof snapshot.raw === 'object' && !Array.isArray(snapshot.raw)) {
          rawKnown = true;
          const raw = snapshot.raw.emotion;
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) rawEmotion = raw;
        }
      } catch { /* 来源不可读时保留 merged 值，避免误删可能的显式覆盖。 */ }

      const emotion = { ...merged };
      for (const key of OVERRIDE_KEYS) {
        // 来源不可读时保留现有值，避免误删显式覆盖；正常 config-store 会提供 raw 快照。
        if (rawKnown && !Object.prototype.hasOwnProperty.call(rawEmotion, key)) emotion[key] = undefined;
      }
      return emotion;
    }
  });
}
