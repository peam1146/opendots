import { expect, it } from 'vitest';
import {
  isIntelligenceThreadId,
  toIntelligenceThreadId,
} from '../src/server/channel-thread.js';

it('passes UUID thread ids through and maps Discord snowflakes to stable UUIDs', () => {
  const uuid = '3015421c-126b-4bd3-bd71-d0a02138fb47';
  const snowflake = '1555492359171473429';
  expect(isIntelligenceThreadId(uuid)).toBe(true);
  expect(isIntelligenceThreadId(snowflake)).toBe(false);
  expect(toIntelligenceThreadId(uuid)).toBe(uuid);
  const mapped = toIntelligenceThreadId(snowflake);
  expect(isIntelligenceThreadId(mapped)).toBe(true);
  expect(mapped).toBe(toIntelligenceThreadId(snowflake));
  expect(mapped).not.toBe(toIntelligenceThreadId('other-channel'));
});
