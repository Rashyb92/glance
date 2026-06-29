import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type {
  AudienceMood,
  ChannelEvent,
  ChatSummary,
  InteractionMode,
  SalienceCategory,
  ScoredMessage,
} from '@glance/core';
import { useGlanceFeed, type ConnectionStatus } from './useGlanceFeed';
import { useOverlaySettings, type OverlaySettings } from './useOverlaySettings';
import { earcon, speak } from './audio';
import { haptic } from './haptics';
import { useBattery, type BatteryState } from './useBattery';
import { parseVoiceCommand } from '@glance/core';
import { useVoice, type Voice } from './useVoice';
import { markMoment } from './api';

// Fallback until the server broadcasts its live engine threshold.
const FALLBACK_THRESHOLD = 0.5;

const DENSITY_COUNTS: Record<OverlaySettings['density'], { raw: number; hybrid: number }> = {
  compact: { raw: 10, hybrid: 6 },
  cozy: { raw: 14, hybrid: 9 },
  roomy: { raw: 18, hybrid: 12 },
};

const CATEGORY: Record<SalienceCategory, { label: string; glyph: string; tone: Tone }> = {
  donation: { label: 'Donation', glyph: '◆', tone: 'gold' },
  event: { label: 'Event', glyph: '⚡', tone: 'gold' },
  question: { label: 'Question', glyph: '?', tone: 'blue' },
  trend: { label: 'Trend', glyph: '▲', tone: 'indigo' },
  mention: { label: 'Mention', glyph: '@', tone: 'teal' },
  moderation: { label: 'Flag', glyph: '⚠', tone: 'red' },
  highlight: { label: 'Highlight', glyph: '★', tone: 'soft' },
  chatter: { label: 'Chatter', glyph: '·', tone: 'muted' },
};

const MOOD: Record<AudienceMood, { label: string; tone: Tone }> = {
  hyped: { label: 'Hyped', tone: 'gold' },
  positive: { label: 'Positive', tone: 'teal' },
  neutral: { label: 'Neutral', tone: 'muted' },
  restless: { label: 'Restless', tone: 'blue' },
  negative: { label: 'Tense', tone: 'red' },
};

type Tone = 'gold' | 'blue' | 'indigo' | 'teal' | 'soft' | 'muted' | 'red';

const MODES: InteractionMode[] = ['raw', 'assist', 'hybrid'];
const MODE_LABEL: Record<InteractionMode, string> = {
  raw: 'Raw Flow',
  assist: 'AI Assist',
  hybrid: 'Hybrid',
};

export function App(): JSX.Element {
  const { status, messages, events, summary, session, settings, priorities, stats } =
    useGlanceFeed();
  const [overlay, setOverlay] = useOverlaySettings();
  const [mode, setMode] = useState<InteractionMode>('hybrid');
  const [panelOpen, setPanelOpen] = useState(false);
  const topPriority = priorities[0];
  const branding = settings?.branding;
  const accentStyle = branding?.accentColor ? { color: branding.accentColor } : undefined;
  const battery = useBattery();
  const [heard, setHeard] = useState<string[]>([]);
  const viewers = session?.viewers ?? null;

  const threshold = settings?.surfaceThreshold ?? FALLBACK_THRESHOLD;
  const counts = DENSITY_COUNTS[overlay.density];

  const surfaced = useMemo(() => {
    if (mode === 'assist') return [] as ScoredMessage[];
    if (mode === 'raw') return messages.slice(-counts.raw);
    return messages.filter((m) => m.score >= threshold).slice(-counts.hybrid);
  }, [messages, mode, threshold, counts.raw, counts.hybrid]);

  // Audio output (opt-in per device): speak / chime items per the routing matrix.
  const lastPriorityId = useRef<string | null>(null);
  const lastEventId = useRef<string | null>(null);

  useEffect(() => {
    if (!overlay.audio) return;
    const p = priorities[0];
    if (!p || p.id === lastPriorityId.current) return;
    lastPriorityId.current = p.id;
    const channels = settings?.routing?.[p.category] ?? [];
    if (channels.includes('earcon')) {
      earcon(
        p.category === 'donation' ? 'donation' : p.category === 'moderation' ? 'alert' : 'event',
        overlay.volume,
      );
    }
    if (channels.includes('voice')) {
      const line = `${p.author ?? 'chat'} says ${p.text}`;
      speak(line, overlay.volume, true); // priorities interrupt the backlog
      setHeard((h) => [line, ...h].slice(0, 8));
    }
  }, [priorities, overlay.audio, overlay.volume, settings]);

  useEffect(() => {
    if (!overlay.audio) return;
    const e = events[0];
    if (!e || e.event.id === lastEventId.current) return;
    lastEventId.current = e.event.id;
    const channels = settings?.routing?.event ?? [];
    if (channels.includes('earcon')) earcon('event', overlay.volume);
    if (channels.includes('voice')) {
      speak(e.event.summary, overlay.volume);
      setHeard((h) => [e.event.summary, ...h].slice(0, 8));
    }
  }, [events, overlay.audio, overlay.volume, settings]);

  // Haptics: feel high-signal moments per the routing matrix — independent of the audio
  // toggle, so a creator muted on stream can still feel a donation land. No-ops on devices
  // without the Vibration API (desktop, iOS Safari).
  const lastHapticPriorityId = useRef<string | null>(null);
  useEffect(() => {
    const p = priorities[0];
    if (!p || p.id === lastHapticPriorityId.current) return;
    lastHapticPriorityId.current = p.id;
    if ((settings?.routing?.[p.category] ?? []).includes('haptic')) haptic(p.category);
  }, [priorities, settings]);
  const lastHapticEventId = useRef<string | null>(null);
  useEffect(() => {
    const e = events[0];
    if (!e || e.event.id === lastHapticEventId.current) return;
    lastHapticEventId.current = e.event.id;
    if ((settings?.routing?.event ?? []).includes('haptic')) haptic('event');
  }, [events, settings]);

  const handleTranscript = (text: string): void => {
    const res = parseVoiceCommand(text, {
      viewers: session?.viewers ?? null,
      chatters: stats?.chatters ?? 0,
      bitsTotal: stats?.bitsTotal ?? 0,
      questionsWaiting: stats?.questionsWaiting ?? 0,
      mood: stats?.mood ?? 'neutral',
      topSupporter: stats?.topSupporters?.[0],
      summary: summary?.headline,
      topPriority: topPriority ? { author: topPriority.author, text: topPriority.text } : undefined,
      uptimeSec: stats?.uptimeSec,
    });
    if (res.action === 'mute') setOverlay({ audio: false });
    else if (res.action === 'unmute') setOverlay({ audio: true });
    else if (res.action === 'mark') {
      void markMoment().then((url) => {
        if (url) {
          speak('Clip saved.', overlay.volume, false);
          setHeard((h) => ['Glance: clip saved', ...h].slice(0, 8));
        }
      });
    }
    speak(res.speak, overlay.volume, true);
    setHeard((h) => [`you: ${text}`, `Glance: ${res.speak}`, ...h].slice(0, 8));
  };
  const voice = useVoice(handleTranscript);

  const channelLabel = session?.channel
    ? `#${session.channel}`
    : session?.demo
      ? 'demo feed'
      : `#${messages.at(-1)?.message.channel ?? 'glance'}`;
  const showSummary = mode !== 'raw' && summary !== null;

  // Earbud mode: an audio-first, minimal screen (phone in a pocket, one earbud in).
  if (overlay.audioMode) {
    return (
      <AudioStage
        overlay={overlay}
        setOverlay={setOverlay}
        brandName={branding?.name || 'GLANCE'}
        accentStyle={accentStyle}
        status={status}
        viewers={viewers}
        battery={battery}
        heard={heard}
        voice={voice}
      />
    );
  }

  return (
    <div className="stage">
      <div className="scene" />
      <div className="vignette" />

      <div
        className={`hud place-${overlay.placement} dens-${overlay.density} ${overlay.motion ? '' : 'no-motion'}`}
        style={{ opacity: overlay.opacity, transform: `scale(${overlay.scale})` }}
      >
        <header className="hud-top">
          <div className="brand">
            {branding?.logoUrl ? (
              <img
                className="brand-logo"
                src={branding.logoUrl}
                alt=""
                style={{ height: 18, width: 'auto', borderRadius: 4 }}
              />
            ) : (
              <span className="brand-mark" aria-hidden style={accentStyle}>
                ◐
              </span>
            )}
            <span className="brand-word" style={accentStyle}>
              {branding?.name || 'GLANCE'}
            </span>
          </div>
          <div className="hud-meta">
            {viewers != null && <span className="viewers">{formatCount(viewers)} watching</span>}
            <span className="channel">{channelLabel}</span>
            <StatusDot status={status} />
            {battery.level != null && (
              <span className="battery" title={battery.charging ? 'charging' : 'battery'}>
                {battery.charging ? '⚡' : ''}
                {Math.round(battery.level * 100)}%
              </span>
            )}
            <button
              type="button"
              className="gear"
              aria-label="Overlay settings"
              onClick={() => setPanelOpen((o) => !o)}
            >
              {'⚙︎'}
            </button>
          </div>
        </header>

        {panelOpen && (
          <OverlayPanel
            settings={overlay}
            update={setOverlay}
            onClose={() => setPanelOpen(false)}
          />
        )}

        <div className={`feed mode-${mode}`}>
          {mode !== 'raw' && topPriority && (
            <article className="priority-callout">
              <span className="priority-tag">PRIORITY</span>
              <p className="priority-reason">{topPriority.reason}</p>
              <p className="priority-text">
                <span className="priority-author">{topPriority.author}</span> {topPriority.text}
              </p>
            </article>
          )}
          {showSummary && summary && <SummaryCard summary={summary} />}
          {events.slice(0, 3).map((e) => (
            <EventCard key={e.event.id} event={e.event} score={e.score} />
          ))}
          {surfaced.map((m) => (
            <MessageRow key={m.message.id} scored={m} dim={mode === 'raw' && m.score < threshold} />
          ))}
          {mode === 'assist' && !summary && (
            <p className="hint">Listening — AI summaries will appear here.</p>
          )}
          {mode === 'hybrid' && surfaced.length === 0 && !showSummary && (
            <p className="hint">Calm. Nothing needs you right now.</p>
          )}
        </div>

        <footer className="hud-bottom">
          <div className="modes" role="tablist" aria-label="Interaction mode">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={`mode ${mode === m ? 'is-active' : ''}`}
                onClick={() => setMode(m)}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          <div className="legend">
            <span className="dot-accent" /> attention engine · {messages.length} read
          </div>
        </footer>
      </div>
    </div>
  );
}

function OverlayPanel({
  settings,
  update,
  onClose,
}: {
  settings: OverlaySettings;
  update: (patch: Partial<OverlaySettings>) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="panel">
      <div className="panel-head">
        <span>Overlay</span>
        <button type="button" className="panel-x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="panel-row">
        <span>Side</span>
        <div className="seg">
          <button
            type="button"
            className={settings.placement === 'left' ? 'on' : ''}
            onClick={() => update({ placement: 'left' })}
          >
            Left
          </button>
          <button
            type="button"
            className={settings.placement === 'right' ? 'on' : ''}
            onClick={() => update({ placement: 'right' })}
          >
            Right
          </button>
        </div>
      </div>
      <label className="panel-row col">
        <span>Size {Math.round(settings.scale * 100)}%</span>
        <input
          type="range"
          min={0.85}
          max={1.2}
          step={0.05}
          value={settings.scale}
          onChange={(e) => update({ scale: Number(e.target.value) })}
        />
      </label>
      <label className="panel-row col">
        <span>Opacity {Math.round(settings.opacity * 100)}%</span>
        <input
          type="range"
          min={0.5}
          max={1}
          step={0.05}
          value={settings.opacity}
          onChange={(e) => update({ opacity: Number(e.target.value) })}
        />
      </label>
      <div className="panel-row">
        <span>Density</span>
        <div className="seg">
          {(['compact', 'cozy', 'roomy'] as const).map((d) => (
            <button
              key={d}
              type="button"
              className={settings.density === d ? 'on' : ''}
              onClick={() => update({ density: d })}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-row">
        <span>Motion</span>
        <button
          type="button"
          className={`toggle ${settings.motion ? 'on' : ''}`}
          onClick={() => update({ motion: !settings.motion })}
        >
          {settings.motion ? 'On' : 'Off'}
        </button>
      </div>
      <div className="panel-row">
        <span>Audio (this device)</span>
        <button
          type="button"
          className={`toggle ${settings.audio ? 'on' : ''}`}
          onClick={() => update({ audio: !settings.audio })}
        >
          {settings.audio ? 'On' : 'Off'}
        </button>
      </div>
      {settings.audio && (
        <label className="panel-row col">
          <span>Volume {Math.round(settings.volume * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            onChange={(e) => update({ volume: Number(e.target.value) })}
          />
        </label>
      )}
      <div className="panel-row">
        <span>Earbud mode</span>
        <button
          type="button"
          className={`toggle ${settings.audioMode ? 'on' : ''}`}
          onClick={() =>
            update({
              audioMode: !settings.audioMode,
              audio: settings.audioMode ? settings.audio : true,
            })
          }
        >
          {settings.audioMode ? 'On' : 'Off'}
        </button>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: ConnectionStatus }): JSX.Element {
  const label = status === 'online' ? 'live' : status === 'connecting' ? 'connecting' : 'offline';
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}

function ScoreBar({ score, tone }: { score: number; tone: Tone }): JSX.Element {
  return (
    <span className="scorebar" title={`salience ${score.toFixed(2)}`}>
      <span
        className={`scorebar-fill tone-${tone}`}
        style={{ width: `${Math.round(score * 100)}%` }}
      />
    </span>
  );
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }): JSX.Element {
  return <span className={`chip tone-${tone}`}>{children}</span>;
}

function MessageRow({ scored, dim }: { scored: ScoredMessage; dim: boolean }): JSX.Element {
  const { message, category, score } = scored;
  const meta = CATEGORY[category];
  return (
    <article className={`row ${dim ? 'is-dim' : ''}`}>
      <div className="row-head">
        <span className="author" style={message.color ? { color: message.color } : undefined}>
          {message.author}
        </span>
        <span
          style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.45 }}
        >
          {message.platform}
        </span>
        <Chip tone={meta.tone}>
          <span className="chip-glyph">{meta.glyph}</span>
          {meta.label}
        </Chip>
        {message.bits ? <span className="bits">{message.bits} bits</span> : null}
      </div>
      <p className="row-text">{message.text}</p>
      <ScoreBar score={score} tone={meta.tone} />
    </article>
  );
}

function EventCard({ event, score }: { event: ChannelEvent; score: number }): JSX.Element {
  return (
    <article className="event">
      <span className="event-glyph">⚡</span>
      <div className="event-body">
        <span className="event-kind">{event.kind.replace('_', ' ')}</span>
        <p className="event-summary">{event.summary}</p>
      </div>
      <ScoreBar score={score} tone="gold" />
    </article>
  );
}

function SummaryCard({ summary }: { summary: ChatSummary }): JSX.Element {
  const mood = summary.mood ? MOOD[summary.mood] : undefined;
  return (
    <article className="summary">
      <div className="summary-head">
        <span className="summary-tag">{summary.source === 'ai' ? 'Claude' : 'Engine'}</span>
        {mood && <Chip tone={mood.tone}>{mood.label}</Chip>}
      </div>
      <h2 className="summary-headline">{summary.headline}</h2>
      {summary.detail && summary.detail.length > 0 && (
        <ul className="summary-detail">
          {summary.detail.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function AudioStage({
  overlay,
  setOverlay,
  brandName,
  accentStyle,
  status,
  viewers,
  battery,
  heard,
  voice,
}: {
  overlay: OverlaySettings;
  setOverlay: (patch: Partial<OverlaySettings>) => void;
  brandName: string;
  accentStyle: { color: string } | undefined;
  status: ConnectionStatus;
  viewers: number | null;
  battery: BatteryState;
  heard: string[];
  voice: Voice;
}): JSX.Element {
  const accent = accentStyle?.color ?? '#7c5cff';
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'radial-gradient(120% 120% at 50% 0%, #14141c 0%, #0a0a0f 70%)',
        color: '#e8e8f0',
      }}
    >
      <div
        style={{
          width: 'min(440px, 94vw)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            width: '100%',
            fontSize: 13,
            opacity: 0.85,
          }}
        >
          <span className="brand-word" style={accentStyle}>
            {brandName}
          </span>
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {viewers != null && <span>{formatCount(viewers)} watching</span>}
            <StatusDot status={status} />
            {battery.level != null && (
              <span>
                {battery.charging ? '⚡' : ''}
                {Math.round(battery.level * 100)}%
              </span>
            )}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setOverlay({ audio: !overlay.audio })}
          aria-pressed={overlay.audio}
          style={{
            width: 168,
            height: 168,
            borderRadius: '50%',
            border: `2px solid ${overlay.audio ? accent : '#3a3a44'}`,
            background: overlay.audio ? `${accent}22` : 'transparent',
            color: overlay.audio ? '#fff' : '#9a9aa6',
            fontSize: 18,
            cursor: 'pointer',
            boxShadow: overlay.audio ? `0 0 40px ${accent}55` : 'none',
          }}
        >
          {overlay.audio ? 'Listening' : 'Muted'}
        </button>

        <label
          style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}
        >
          <span>Volume {Math.round(overlay.volume * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={overlay.volume}
            onChange={(e) => setOverlay({ volume: Number(e.target.value) })}
          />
        </label>

        {voice.supported && (
          <button
            type="button"
            onClick={voice.toggle}
            style={{
              width: '100%',
              padding: '12px 16px',
              borderRadius: 12,
              border: `1px solid ${voice.listening ? accent : '#3a3a44'}`,
              background: voice.listening ? `${accent}22` : 'rgba(255,255,255,0.04)',
              color: '#e8e8f0',
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            {voice.listening ? 'Listening…' : '🎤 Ask Glance'}
          </button>
        )}

        <div style={{ width: '100%' }}>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 1,
              opacity: 0.5,
              marginBottom: 6,
            }}
          >
            Last heard
          </div>
          {heard.length === 0 ? (
            <p className="hint">Nothing yet — callouts will be spoken aloud.</p>
          ) : (
            heard.map((line, i) => (
              <div
                key={i}
                style={{
                  fontSize: 14,
                  padding: '6px 0',
                  borderBottom: '1px solid #ffffff10',
                  opacity: 1 - i * 0.1,
                }}
              >
                {line}
              </div>
            ))
          )}
        </div>

        <button
          type="button"
          onClick={() => setOverlay({ audioMode: false })}
          style={{
            marginTop: 4,
            background: 'transparent',
            border: '1px solid #3a3a44',
            color: '#c8c8d2',
            borderRadius: 8,
            padding: '8px 14px',
            cursor: 'pointer',
          }}
        >
          Exit earbud mode
        </button>
        <p style={{ fontSize: 12, opacity: 0.5, textAlign: 'center', margin: 0 }}>
          Screen can sleep — keep this open with one earbud in.
        </p>
      </div>
    </div>
  );
}

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
