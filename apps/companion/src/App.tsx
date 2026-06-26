import { useEffect, useRef, useState } from 'react';
import { parseVoiceCommand } from '@glance/core';
import { useFeed } from './useFeed';
import { earcon, speak } from './audio';
import { useVoice } from './useVoice';
import { markMoment } from './api';

export function App(): JSX.Element {
  const { status, priorities, events, session, settings, stats, summary } = useFeed();
  const [audio, setAudio] = useState(true);
  const [volume, setVolume] = useState(0.8);
  const [notify, setNotify] = useState(false);
  const [heard, setHeard] = useState<string[]>([]);
  const lastPriorityId = useRef<string | null>(null);
  const lastEventId = useRef<string | null>(null);

  const top = priorities[0];
  const viewers = session?.viewers ?? null;

  // "Ask Glance": speech → intent → spoken answer (and optional mute/unmute action).
  const handleTranscript = (text: string): void => {
    const res = parseVoiceCommand(text, {
      viewers: session?.viewers ?? null,
      chatters: stats?.chatters ?? 0,
      bitsTotal: stats?.bitsTotal ?? 0,
      questionsWaiting: stats?.questionsWaiting ?? 0,
      mood: stats?.mood ?? 'neutral',
      topSupporter: stats?.topSupporters?.[0],
      summary: summary?.headline,
      topPriority: top ? { author: top.author, text: top.text } : undefined,
      uptimeSec: stats?.uptimeSec,
    });
    if (res.action === 'mute') setAudio(false);
    else if (res.action === 'unmute') setAudio(true);
    else if (res.action === 'mark') {
      void markMoment().then((url) => {
        if (url) {
          speak('Clip saved.', volume, false);
          setHeard((h) => ['Glance: clip saved', ...h].slice(0, 12));
        }
      });
    }
    speak(res.speak, volume, true);
    setHeard((h) => [`you: ${text}`, `Glance: ${res.speak}`, ...h].slice(0, 12));
  };
  const voice = useVoice(handleTranscript);

  // Priority callouts: chime / speak per the routing matrix, and notify when backgrounded.
  useEffect(() => {
    const p = priorities[0];
    if (!p || p.id === lastPriorityId.current) return;
    lastPriorityId.current = p.id;
    const channels = settings?.routing?.[p.category] ?? [];
    if (audio && channels.includes('earcon')) {
      earcon(p.category === 'donation' ? 'donation' : p.category === 'moderation' ? 'alert' : 'event', volume);
    }
    if (audio && channels.includes('voice')) {
      const line = `${p.author ?? 'chat'} says ${p.text}`;
      speak(line, volume, true);
      setHeard((h) => [line, ...h].slice(0, 10));
    }
    if (notify && document.hidden) notification('Worth answering', `${p.author ?? 'chat'}: ${p.text}`);
  }, [priorities, audio, volume, settings, notify]);

  // Channel events (donations, raids, subs).
  useEffect(() => {
    const e = events[0];
    if (!e || e.event.id === lastEventId.current) return;
    lastEventId.current = e.event.id;
    const channels = settings?.routing?.event ?? [];
    if (audio && channels.includes('earcon')) earcon('event', volume);
    if (audio && channels.includes('voice')) {
      speak(e.event.summary, volume);
      setHeard((h) => [e.event.summary, ...h].slice(0, 10));
    }
    if (notify && document.hidden) notification('Channel event', e.event.summary);
  }, [events, audio, volume, settings, notify]);

  const enableNotifications = async (): Promise<void> => {
    if (!('Notification' in window)) return;
    const perm = await Notification.requestPermission();
    setNotify(perm === 'granted');
  };

  return (
    <div className="companion">
      <header className="c-top">
        <span className="c-brand">◐ Glance</span>
        <span className="c-meta">
          {viewers != null && <span>{fmt(viewers)} watching</span>}
          <span className={`c-status c-status-${status}`}>{status === 'online' ? 'live' : status}</span>
        </span>
      </header>

      <button
        type="button"
        className={`c-orb ${audio ? 'on' : ''}`}
        aria-pressed={audio}
        onClick={() => setAudio((a) => !a)}
      >
        {audio ? 'Listening' : 'Muted'}
      </button>

      <label className="c-vol">
        <span>Volume {Math.round(volume * 100)}%</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
        />
      </label>

      {voice.supported && (
        <button
          type="button"
          className={`c-mic ${voice.listening ? 'on' : ''}`}
          onClick={voice.toggle}
        >
          {voice.listening ? 'Listening…' : '🎤 Ask Glance'}
        </button>
      )}

      {top && (
        <div className="c-priority">
          <span className="c-priority-tag">Priority</span>
          <div className="c-priority-text">
            <b>{top.author ?? 'chat'}</b> {top.text}
          </div>
          <div className="c-priority-reason">{top.reason}</div>
        </div>
      )}

      <div className="c-glance">
        <Stat label="Watching" value={viewers != null ? fmt(viewers) : '—'} />
        <Stat label="Chatters" value={stats ? fmt(stats.chatters) : '—'} />
        <Stat label="Msgs/min" value={stats ? fmt(stats.messagesPerMin) : '—'} />
      </div>

      <div className="c-heard">
        <div className="c-heard-label">Last heard</div>
        {heard.length === 0 ? (
          <p className="c-hint">Callouts will be spoken aloud.</p>
        ) : (
          heard.map((line, i) => (
            <div className="c-line" key={i}>
              {line}
            </div>
          ))
        )}
      </div>

      {!notify && 'Notification' in window && (
        <button type="button" className="c-alt" onClick={() => void enableNotifications()}>
          Enable alerts
        </button>
      )}
      <p className="c-foot">
        Keep this open with an earbud in — screen can sleep. Add to Home Screen to install.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="c-stat">
      <div className="c-stat-value">{value}</div>
      <div className="c-stat-label">{label}</div>
    </div>
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function notification(title: string, body: string): void {
  try {
    new Notification(title, { body });
  } catch {
    /* notifications unavailable */
  }
}
