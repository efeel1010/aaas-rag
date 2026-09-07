import type { HealthResult } from '@pulse/contracts';
import { get } from '../lib/api.js';

export function getHealth(): Promise<HealthResult> {
  return get('/health');
}
