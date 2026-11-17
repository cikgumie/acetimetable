import { solve } from './solver.js';

self.onmessage = (e) => {
  const { state, opts } = e.data;
  try {
    const result = solve(state, opts, p => self.postMessage({ type: 'progress', ...p }));
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
