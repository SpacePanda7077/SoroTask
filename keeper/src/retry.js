export async function retry(fn, attempts = 3, delay = 1000) {
  let lastError;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) {
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }

  throw lastError;
}
