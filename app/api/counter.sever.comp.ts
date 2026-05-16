/**
 * Server component: counter
 * Runs on the server only. Called from the client via Vula.server().
 */
export default async function counter(currentValue: number) {
  return currentValue + 1;
}
