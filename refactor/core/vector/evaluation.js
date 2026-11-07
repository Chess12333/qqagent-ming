const SPLITS = Object.freeze(['anchor-seed', 'development', 'frozen-holdout']);

export function assertEvaluationInput(example, actualText) {
  if (!example || typeof example !== 'object') throw new TypeError('evaluation example must be an object');
  if (!Number.isFinite(example.eventAt)) throw new TypeError('eventAt must be a finite timestamp');
  if (!Array.isArray(example.inputEvents)) throw new TypeError('inputEvents must be an array');
  if (typeof actualText !== 'string') throw new TypeError('actual query text must be a string');
  if (!example.inputEvents.every((event) => typeof event?.text === 'string')) throw new TypeError('every input event must carry its text');
  for (const event of example.inputEvents) {
    if (!event || !Number.isFinite(event.at) || event.at > example.eventAt) throw new Error('evaluation input contains an event after the query eventAt');
    if (event.kind === 'feedback' || event.isFeedback === true || event.answerOnly === true) throw new Error('subsequent feedback is answer-only and cannot enter vector input');
  }
  const derivedInput = example.inputEvents.map((event) => event.text).join('\n');
  if (derivedInput !== actualText) throw new Error('query text must be derived exactly from the time-bounded inputEvents');
  if (Array.isArray(example.input) && example.input.some((part) => part?.kind === 'feedback' || part?.isFeedback === true || part?.answerOnly === true)) {
    throw new Error('subsequent feedback is answer-only and cannot enter vector input');
  }
  return true;
}

export function validateEvaluationSplits(groups) {
  const errors = [];
  if (!groups || typeof groups !== 'object') return { ok: false, errors: ['split groups must be an object'] };
  const seenEvents = new Map();
  const seenSources = new Map();
  for (const split of SPLITS) {
    if (!Array.isArray(groups[split])) { errors.push(`${split} must be an array`); continue; }
    for (const row of groups[split]) {
      for (const [field, map] of [['eventId', seenEvents], ['sourceId', seenSources]]) {
        if (!row?.[field]) { errors.push(`${split} row missing ${field}`); continue; }
        if (map.has(row[field]) && map.get(row[field]) !== split) errors.push(`${field} ${row[field]} overlaps ${map.get(row[field])} and ${split}`);
        map.set(row[field], split);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
