import { useMemo, useState, type ReactNode } from 'react';
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
  const { status, messages, events, summary, session, settings } = useGlanceFeed();
  const [overlay, setOverlay] = useOverlaySettings();
  const [mode, setMode] = useState<InteractionMode>('hybrid');
  const [panelOpen, setPanelOpen] = useState(false);

  const threshold = settings?.surfaceThreshold ?? FALLBACK_THRESHOLD;
  const counts = DENSITY_COUNTS[overlay.density];

  const surfaced = useMemo(() => {
    if (mode === 'assist') return [] as ScoredMessage[];
    if (mode === 'raw') return messages.slice(-counts.raw);
    return messages.filter((m) => m.score >= threshold).slice(-counts.hybrid);
  }, [messages, mode, threshold, counts.raw, counts.hybrid]);

  const channelLabel = session?.channel
    ? `#${session.channel}`
    : session?.demo
      ? 'demo feed'
      : `#${messages.at(-1)?.message.channel ?? 'glance'}`;
  const showSummary = mode !== 'raw' && summary !== null;

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
            <span className="brand-mark" aria-hidden>
              ◐
            </span>
            <span className="brand-word">GLANCE</span>
          </div>
          <div className="hud-meta">
            <span className="channel">{channelLabel}</span>
            <StatusDot status={status} />
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
          <OverlayPanel settings={overlay} update={setOverlay} onClose={() => setPanelOpen(false)} />
        )}

        <div className={`feed mode-${mode}`}>
          {showSummary && summary && <SummaryCard summary={summary} />}
          {events.slice(0, 3).map((e) => (
            <EventCard key={e.event.id} event={e.event} score={e.score} />
          ))}
          {surfaced.map((m) => (
            <MessageRow
              key={m.message.id}
              scored={m}
              dim={mode === 'raw' && m.score < threshold}
            />
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
      <span className={`scorebar-fill tone-${tone}`} style={{ width: `${Math.round(score * 100)}%` }} />
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
