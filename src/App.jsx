import { useState, useRef, useCallback } from 'react';
import { supabase } from './supabaseClient';
import { EVENT_CODE, EVENT_NAME, CATEGORIES } from './config';

export default function App() {
  const [step, setStep] = useState('code');
  const [judgeCode, setJudgeCode] = useState('');
  const [judgeName, setJudgeName] = useState('');
  const [entries, setEntries] = useState([]); // unordered list of entry numbers from Supabase
  const [notes, setNotes] = useState({});
  const [submittedAt, setSubmittedAt] = useState(null);
  const [saveStatus, setSaveStatus] = useState('idle');
  const [error, setError] = useState('');

  const handleCodeSubmit = async () => {
    setError('');
    const code = judgeCode.trim();
    if (!code) return;

    const { data, error: dbErr } = await supabase
      .from('ranking_submissions')
      .select('*')
      .eq('event_code', EVENT_CODE)
      .eq('judge_code', code)
      .maybeSingle();

    if (dbErr || !data) {
      setError('Code not recognized. Check with the event organizer.');
      return;
    }

    setEntries(data.ranking || []);
    setNotes(data.notes || {});
    setSubmittedAt(data.submitted_at);

    if (data.submitted_at) {
      setJudgeName(data.judge_name || '');
      setStep('submitted');
    } else if (!data.judge_name) {
      setStep('name');
    } else {
      setJudgeName(data.judge_name);
      setStep('rank');
    }
  };

  const handleNameSubmit = async () => {
    const name = judgeName.trim();
    if (!name) return;

    const { error: dbErr } = await supabase
      .from('ranking_submissions')
      .update({
        judge_name: name,
        last_updated: new Date().toISOString(),
      })
      .eq('event_code', EVENT_CODE)
      .eq('judge_code', judgeCode);

    if (dbErr) {
      setError('Could not save name. Try again.');
      return;
    }

    setStep('rank');
  };

  const saveTimer = useRef(null);

  const saveToSupabase = useCallback(
    async (newEntries, newNotes) => {
      setSaveStatus('saving');

      const { error: dbErr } = await supabase
        .from('ranking_submissions')
        .update({
          ranking: newEntries,
          notes: newNotes,
          last_updated: new Date().toISOString(),
        })
        .eq('event_code', EVENT_CODE)
        .eq('judge_code', judgeCode);

      setSaveStatus(dbErr ? 'error' : 'saved');
    },
    [judgeCode]
  );

  const scheduleSave = useCallback(
    (newEntries, newNotes) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveToSupabase(newEntries, newNotes);
      }, 600);
    },
    [saveToSupabase]
  );

  const handleNotesUpdate = (entryNum, updatedEntryNotes) => {
    setNotes((prev) => {
      const next = { ...prev, [entryNum]: updatedEntryNotes };
      scheduleSave(entries, next);
      return next;
    });
  };

  const handleSubmit = async () => {
    // Check for ties (including unscored entries, which all tie at 0)
    const ties = findTies(entries, notes);
    if (ties.length > 0) {
      const lines = ties.map(({ score, entries: group }) => {
        const list = group.map((n) => `#${n}`).join(', ');
        return score === 0
          ? `  • Entries ${list} — not yet scored (0/100)`
          : `  • Entries ${list} — tied at ${score}/100`;
      });
      window.alert(
        `Please resolve these ties before submitting:\n\n${lines.join('\n')}`
      );
      return;
    }

    const ok = window.confirm(
      'Submit your final scores? You will not be able to edit after this.'
    );

    if (!ok) return;

    // Derive final ranked order from scores at submit time
    const finalRanking = [...entries].sort(
      (a, b) => totalScore(notes[b]) - totalScore(notes[a])
    );

    const { error: dbErr } = await supabase
      .from('ranking_submissions')
      .update({
        submitted_at: new Date().toISOString(),
        ranking: finalRanking,
        notes,
        last_updated: new Date().toISOString(),
      })
      .eq('event_code', EVENT_CODE)
      .eq('judge_code', judgeCode);

    if (dbErr) {
      setError('Submit failed. Try again.');
      return;
    }

    setSubmittedAt(new Date().toISOString());
    setStep('submitted');
  };

  if (step === 'code') {
    return (
      <div className="page-wrapper">
        <div className="top-header">
          <img
            src="/mothership.jpeg"
            alt="Mothership Meltdown"
            className="top-header-image"
          />
        </div>

        <div className="screen">
          <h1>{EVENT_NAME}</h1>
          <p className="muted">Enter your judge code to begin or resume.</p>
          <input
            className="input"
            value={judgeCode}
            onChange={(e) => setJudgeCode(e.target.value)}
            placeholder="Judge code"
            autoCapitalize="off"
          />
          <button className="btn-primary" onClick={handleCodeSubmit}>
            Continue
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    );
  }

  if (step === 'name') {
    return (
      <div className="page-wrapper">
        <div className="top-header">
          <img
            src="/mothership.jpeg"
            alt="Mothership Meltdown"
            className="top-header-image"
          />
        </div>

        <div className="screen">
          <h1>Welcome</h1>
          <p className="muted">What name should appear on your scorecard?</p>
          <input
            className="input"
            value={judgeName}
            onChange={(e) => setJudgeName(e.target.value)}
            placeholder="Your name"
          />
          <button className="btn-primary" onClick={handleNameSubmit}>
            Start Judging
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    );
  }

  if (step === 'submitted') {
    return (
      <div className="page-wrapper">
        <div className="top-header">
          <img
            src="/mothership.jpeg"
            alt="Mothership Meltdown"
            className="top-header-image"
          />
        </div>

        <div className="screen">
          <h1>Submitted</h1>
          <p>Thanks, {judgeName}. Your scores have been locked in.</p>
          <p className="muted">
            Submitted {new Date(submittedAt).toLocaleString()}.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ScoringScreen
      judgeName={judgeName}
      entries={entries}
      notes={notes}
      onNotesUpdate={handleNotesUpdate}
      onSubmit={handleSubmit}
      saveStatus={saveStatus}
    />
  );
}

function ScoringScreen({
  judgeName,
  entries,
  notes,
  onNotesUpdate,
  onSubmit,
  saveStatus,
}) {
  const [openEntry, setOpenEntry] = useState(null);

  // Always sorted by total score descending — updates automatically on every score change
  const sortedEntries = [...entries].sort(
    (a, b) => totalScore(notes[b]) - totalScore(notes[a])
  );

  return (
    <div className="rank-screen">
      <div className="top-header">
        <img
          src="/mothership.jpeg"
          alt="Mothership Meltdown"
          className="top-header-image"
        />
      </div>

      <header className="rank-header">
        <div>
          <div className="judge-name">{judgeName}</div>
          <div className="save-status">{saveStatusLabel(saveStatus)}</div>
        </div>

        <button className="btn-submit" onClick={onSubmit}>
          Submit
        </button>
      </header>

      <p className="muted small">
        Tap an entry to score it. Rankings update automatically.
      </p>

      <ul className="rank-list">
        {sortedEntries.map((entryNum, idx) => (
          <EntryRow
            key={entryNum}
            id={entryNum}
            position={idx + 1}
            hasNotes={hasAnyNote(notes[entryNum])}
            score={totalScore(notes[entryNum])}
            onTap={() => setOpenEntry(entryNum)}
          />
        ))}
      </ul>

      {openEntry !== null && (
        <EntryModal
          entryNum={openEntry}
          notes={notes[openEntry] || {}}
          onClose={() => setOpenEntry(null)}
          onSave={(updated) => onNotesUpdate(openEntry, updated)}
        />
      )}
    </div>
  );
}

function EntryRow({ id, position, hasNotes, score, onTap }) {
  return (
    <li className="rank-item">
      <span className="position">{position}</span>
      <span className="entry-num">Entry #{id}</span>
      <span className="entry-score">{score}/100</span>
      <button
        className="notes-btn"
        onClick={onTap}
        aria-label="Score and add notes"
      >
        {hasNotes ? '📝' : '＋'}
      </button>
    </li>
  );
}

function EntryModal({ entryNum, notes, onClose, onSave }) {
  const [local, setLocal] = useState(notes);

  const updateField = (key, field, value) => {
    const next = {
      ...local,
      [key]: {
        ...(local[key] || {}),
        [field]: value,
      },
    };
    setLocal(next);
    onSave(next);
  };

  const updateTopLevel = (key, value) => {
    const next = { ...local, [key]: value };
    setLocal(next);
    onSave(next);
  };

  const handlePlacement = (value) => {
    updateTopLevel('placement', local.placement === value ? null : value);
  };

  const runningTotal = totalScore(local);
  const maxTotal = CATEGORIES.reduce((sum, c) => sum + c.maxScore, 0);

  const PLACEMENT_OPTIONS = [
    { value: 'mids', label: 'Mids', className: 'placement-mids' },
    { value: 'average', label: 'Average', className: 'placement-average' },
    { value: 'fire', label: 'Fire 🔥', className: 'placement-fire' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Entry #{entryNum}</h2>

          <div className="modal-header-right">
            <span className="modal-total">
              {runningTotal} / {maxTotal}
            </span>
            <button className="close-btn" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </header>

        <div className="modal-body">
          {CATEGORIES.map((cat) => (
            <div key={cat.key} className="category-block">
              <div className="cat-header">
                <label className="cat-label">{cat.label}</label>
                <ScoreStepper
                  value={local[cat.key]?.score ?? 0}
                  max={cat.maxScore}
                  onChange={(val) => updateField(cat.key, 'score', val)}
                />
              </div>

              <p className="cat-desc">{cat.description}</p>

              <textarea
                className="cat-notes"
                value={local[cat.key]?.text || ''}
                onChange={(e) => updateField(cat.key, 'text', e.target.value)}
                placeholder="Notes..."
                rows={2}
              />
            </div>
          ))}

          <div className="modal-divider" />

          <div className="category-block">
            <label className="cat-label">Where does this entry place?</label>
            <div className="placement-options">
              {PLACEMENT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={`placement-btn ${opt.className}${
                    local.placement === opt.value ? ' selected' : ''
                  }`}
                  onClick={() => handlePlacement(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="category-block">
            <label className="cat-label">Overall Notes</label>
            <textarea
              className="cat-notes"
              value={local.overall_notes || ''}
              onChange={(e) => updateTopLevel('overall_notes', e.target.value)}
              placeholder="Overall impressions..."
              rows={3}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ScoreStepper({ value, max, onChange }) {
  const decrement = () => onChange(roundHalf(Math.max(0, value - 0.5)));
  const increment = () => onChange(roundHalf(Math.min(max, value + 0.5)));

  return (
    <div className="stepper">
      <button
        className="stepper-btn"
        onClick={decrement}
        disabled={value <= 0}
        aria-label="Decrease score"
      >
        −
      </button>
      <span className="stepper-value">{value}</span>
      <span className="stepper-max">/ {max}</span>
      <button
        className="stepper-btn"
        onClick={increment}
        disabled={value >= max}
        aria-label="Increase score"
      >
        +
      </button>
    </div>
  );
}

function roundHalf(val) {
  return Math.round(val * 2) / 2;
}

function findTies(entries, notes) {
  const byScore = {};
  for (const entryNum of entries) {
    const s = totalScore(notes[entryNum]);
    if (!byScore[s]) byScore[s] = [];
    byScore[s].push(entryNum);
  }
  return Object.entries(byScore)
    .filter(([, group]) => group.length > 1)
    .map(([score, group]) => ({ score: Number(score), entries: group }));
}

// Returns a number — 0 if no scores entered yet
function totalScore(entryNotes) {
  if (!entryNotes) return 0;
  let total = 0;
  for (const cat of CATEGORIES) {
    const val = entryNotes[cat.key];
    if (val && val.score !== undefined && val.score !== '') {
      total += Number(val.score);
    }
  }
  return total;
}

// Only true if judge has entered a score > 0, written any notes, or selected a placement
function hasAnyNote(entryNotes) {
  if (!entryNotes) return false;
  if (entryNotes.placement) return true;
  if (entryNotes.overall_notes && entryNotes.overall_notes.trim().length > 0)
    return true;
  return CATEGORIES.some((cat) => {
    const v = entryNotes[cat.key];
    return (
      v &&
      ((typeof v.score === 'number' && v.score > 0) ||
        (v.text && v.text.trim().length > 0))
    );
  });
}

function saveStatusLabel(status) {
  switch (status) {
    case 'saving':
      return 'Saving…';
    case 'saved':
      return 'Saved ✓';
    case 'error':
      return 'Save failed — check connection';
    default:
      return '';
  }
}
