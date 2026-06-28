import { describe, it, expect } from 'vitest';
import { isPrivateIp, isSafePushEndpoint } from '../src/push-store';

describe('isPrivateIp', () => {
  it('flags private / loopback / metadata / CGNAT (v4 + v6) and allows public', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '::1',
      'fd00::1',
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });
});

describe('isSafePushEndpoint', () => {
  it('accepts public https, rejects http / localhost / private literals', () => {
    expect(isSafePushEndpoint('https://hooks.example.com/x')).toBe(true);
    expect(isSafePushEndpoint('http://example.com')).toBe(false);
    expect(isSafePushEndpoint('https://localhost/x')).toBe(false);
    expect(isSafePushEndpoint('https://10.0.0.5/x')).toBe(false);
    expect(isSafePushEndpoint('https://169.254.169.254/latest/meta-data')).toBe(false);
  });
});
