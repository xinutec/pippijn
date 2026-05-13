/**
 * Feature flag for the factor-decomposed classifier path.
 *
 * Read once per call (cheap) so tests can flip it via `vi.stubEnv`
 * without restarting the process. In production: set
 * `USE_FACTOR_SCORER=1` in the pod env to enable; absent or any
 * other value keeps the legacy rule cascade.
 *
 * The flag will be removed once the factor path has been running in
 * production for at least one calibration cycle and the
 * classification-snapshot CI check is in place (synthetic CI
 * fixtures, task #103).
 */

export function useFactorScorer(): boolean {
	return process.env.USE_FACTOR_SCORER === "1";
}
