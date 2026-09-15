// One process-wide queue for every Workiz request. Keeping the budget here
// prevents independent sync flows from each consuming the provider limit.
const state = { tail: Promise.resolve(), nextRequestAt: 0 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const spacingMs = () => Math.max(0, Number(process.env.WORKIZ_MIN_REQUEST_INTERVAL_MS || 100));
const maxRetries = () => Math.max(0, Number(process.env.WORKIZ_429_MAX_RETRIES || 3));
const baseBackoffMs = () => Math.max(1, Number(process.env.WORKIZ_429_BACKOFF_MS || 500));

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  }
  return baseBackoffMs() * 2 ** attempt;
}

async function enterBudget() {
  const wait = Math.max(0, state.nextRequestAt - Date.now());
  if (wait) await sleep(wait);
  state.nextRequestAt = Date.now() + spacingMs();
}

export function workizFetch(operation) {
  const run = async () => {
    for (let attempt = 0; ; attempt += 1) {
      await enterBudget();
      const response = await operation();
      if (response.status !== 429 || attempt >= maxRetries()) return response;
      const delay = retryDelay(response, attempt);
      state.nextRequestAt = Math.max(state.nextRequestAt, Date.now() + delay);
    }
  };
  const result = state.tail.then(run, run);
  state.tail = result.then(() => undefined, () => undefined);
  return result;
}

export function resetWorkizRateLimitForTest() {
  state.tail = Promise.resolve();
  state.nextRequestAt = 0;
}
