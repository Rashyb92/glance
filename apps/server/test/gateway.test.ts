import { describe, it, expect } from 'vitest';
import { originAllowed, corsHeaders } from '../src/gateway';

describe('originAllowed', () => {
  it('allows no-origin (native / CLI clients) and the default localhost origins', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('http://localhost:5173')).toBe(true);
    expect(originAllowed('http://localhost:5174')).toBe(true);
  });

  it('blocks an unknown browser origin', () => {
    expect(originAllowed('https://evil.example')).toBe(false);
  });
});

describe('corsHeaders', () => {
  it('reflects an allowed origin', () => {
    expect(corsHeaders('http://localhost:5173')['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    );
  });

  it('omits the allow-origin header for a disallowed origin', () => {
    expect(corsHeaders('https://evil.example')['access-control-allow-origin']).toBeUndefined();
  });
});
