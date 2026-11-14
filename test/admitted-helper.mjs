import { reconcileAdmission } from '../src/transcript.mjs';
// What the live observation says once the file already holds everything it will hold: it stops at the first empty look instead of waiting for more.
export const admitted = proof => { const stop = new AbortController(); return reconcileAdmission(proof, { signal: stop.signal, testHooks: { afterEmptyAdmissionProbe: () => stop.abort() } }); };
