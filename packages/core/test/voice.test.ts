import { describe, it, expect } from 'vitest';
import { parseVoiceCommand, type VoiceSnapshot } from '../src/voice';

const base: VoiceSnapshot = {
  viewers: 1280,
  chatters: 45,
  bitsTotal: 500,
  questionsWaiting: 3,
  mood: 'hyped',
  topSupporter: { author: 'Whale', bits: 500 },
  summary: 'Chat is loving the new map.',
  topPriority: { author: 'Ana', text: 'what sensitivity do you use?' },
  uptimeSec: 7200,
};

describe('parseVoiceCommand', () => {
  it('answers donations with total and top supporter', () => {
    const r = parseVoiceCommand('any donations?', base);
    expect(r.intent).toBe('donations');
    expect(r.speak).toContain('500 bits');
    expect(r.speak).toContain('Whale');
  });

  it('answers viewers and questions', () => {
    expect(parseVoiceCommand('how many viewers right now', base).speak).toContain('1280');
    expect(parseVoiceCommand('any questions waiting', base).speak).toBe('3 questions waiting.');
  });

  it('reads the summary and the top priority', () => {
    expect(parseVoiceCommand("what's happening", base).speak).toBe('Chat is loving the new map.');
    const p = parseVoiceCommand('what should I answer', base);
    expect(p.intent).toBe('priority');
    expect(p.speak).toContain('Ana');
  });

  it('treats mute / unmute as control actions', () => {
    expect(parseVoiceCommand('mute yourself', base).action).toBe('mute');
    expect(parseVoiceCommand('resume', base).action).toBe('unmute');
  });

  it('reports the mood and falls back helpfully', () => {
    expect(parseVoiceCommand('what is the vibe', base).speak).toContain('hyped');
    expect(parseVoiceCommand('make me a sandwich', base).intent).toBe('unknown');
  });

  it('handles an empty session gracefully', () => {
    const empty: VoiceSnapshot = {
      viewers: null,
      chatters: 0,
      bitsTotal: 0,
      questionsWaiting: 0,
      mood: 'neutral',
    };
    expect(parseVoiceCommand('donations', empty).speak).toBe('No bits yet this session.');
    expect(parseVoiceCommand('viewers', empty).speak).toContain("isn't available");
    expect(parseVoiceCommand('top supporter', empty).speak).toContain('No supporters');
  });

  it('marks a moment on "clip that"', () => {
    const r = parseVoiceCommand('clip that', base);
    expect(r.intent).toBe('mark');
    expect(r.action).toBe('mark');
    expect(parseVoiceCommand('mark that moment', base).action).toBe('mark');
  });

  it('names the top supporter', () => {
    const r = parseVoiceCommand('who is my top supporter', base);
    expect(r.intent).toBe('topSupporter');
    expect(r.speak).toContain('Whale');
    expect(r.speak).toContain('500');
  });

  it('reports uptime in hours and minutes', () => {
    const r = parseVoiceCommand('how long have I been live', base);
    expect(r.intent).toBe('uptime');
    expect(r.speak).toContain('2 hours');
  });
});
