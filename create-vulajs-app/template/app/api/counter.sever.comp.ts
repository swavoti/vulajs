/**
 * Server component: counter
 * Runs on the server only. Called from the client via Vula.server().
 * Server components require authentication by default unless isPublic = true
 * or an authorize(req) guard is exported.
 */
export const isPublic = true;

export default async function counter(currentValue: number) {
  return currentValue + 1;
}
