import { useState, useRef, useCallback, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { EVENT_CODE, EVENT_NAME, CATEGORIES } from './config';

// Raw total is 0–500 (5 cats × 100). Display divides by 5 → shows out of 100.
function displayScore(rawTotal) {
  return Number((rawTotal / CATEGORIES.length).toFixed(1));
}

export default function App() {
  const [step, setStep] = useState('code');
  const [judgeCode, setJudgeCode] = useState('');
  const [judgeName, setJudgeName] = useState('');
  const [entries, setEntries] = useState([]);
  const [notes, setNotes] = useState({});
  const [submittedAt, setSubmittedAt] = useState(null);
  const [saveStatus, setSaveStatus] = useState('idle');
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [error, setError] = useState('');

  const saveTimer = useRef(null);
  const retryTimer = useRef(null);
  const retryCount = useRef(0);

  // Tick every 30s so "saved X ago" display stays fresh
  useEffect(() => {
    const interval = setInterval(() => {
      setLastSavedAt((prev) => (prev ? new Date(prev.getTime()) : prev));
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  // Warn before closing/refreshing if a save is in flight or failed
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (saveStatus === 'saving' || saveStatus === 'error') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [saveStatus]);

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

    // Check localStorage for data that might be newer than Supabase
    // (happens when a save failed due to network issues)
    let finalEntries = data.ranking || [];
    let finalNotes = data.notes || {};
    let restoredFromLocal = false;

    try {
      const localRaw = localStorage.getItem(localKey(EVENT_CODE, code));
      if (localRaw) {
        const localData = JSON.parse(localRaw);
        const localTime = new Date(localData.lastUpdated).getTime();
        const supabaseTime = data.last_updated
          ? new Date(data.last_updated).getTime()
          : 0;
        if (localTime > supabaseTime) {
          finalEntries = localData.ranking || finalEntries;
          finalNotes = localData.notes || {};
          restoredFromLocal = true;
        }
      }
    } catch (_) {
      // localStorage unavailable or corrupt — Supabase data is fine
    }

    setEntries(finalEntries);
    setNotes(finalNotes);
    setSubmittedAt(data.submitted_at);

    if (data.submitted_at) {
      setJudgeName(data.judge_name || '');
      setStep('submitted');
    } else if (!data.judge_name) {
      setStep('name');
    } else {
      setJudgeName(data.judge_name);
      setStep('rank');

      // If localStorage had newer data, sync it back to Supabase immediately
      if (restoredFromLocal) {
        supabase
          .from('ranking_submissions')
          .update({
            ranking: finalEntries,
            notes: finalNotes,
            last_updated: new Date().toISOString(),
          })
          .eq('event_code', EVENT_CODE)
          .eq('judge_code', code);
      }
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

  const saveToSupabase = useCallback(
    async (newEntries, newNotes) => {
      setSaveStatus('saving');
      const now = new Date().toISOString();

      // Mirror to localStorage first — instant, offline-safe fallback
      try {
        localStorage.setItem(
          localKey(EVENT_CODE, judgeCode),
          JSON.stringify({ ranking: newEntries, notes: newNotes, lastUpdated: now })
        );
      } catch (_) {
        // Private browsing or storage full — skip silently
      }

      const { error: dbErr } = await supabase
        .from('ranking_submissions')
        .update({
          ranking: newEntries,
          notes: newNotes,
          last_updated: now,
        })
        .eq('event_code', EVENT_CODE)
        .eq('judge_code', judgeCode);

      if (dbErr) {
        setSaveStatus('error');
        // Exponential backoff retry: 2s, 4s, 8s, 16s, 30s (max 5 attempts)
        if (retryCount.current < 5) {
          const delay = Math.min(30000, 2000 * Math.pow(2, retryCount.current));
          retryCount.current += 1;
          retryTimer.current = setTimeout(() => {
            saveToSupabase(newEntries, newNotes);
          }, delay);
        }
      } else {
        retryCount.current = 0;
        setLastSavedAt(new Date());
        setSaveStatus('saved');
      }
    },
    [judgeCode]
  );

  const scheduleSave = useCallback(
    (newEntries, newNotes) => {
      // Cancel any pending debounce or retry before scheduling a fresh save
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryCount.current = 0;

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
    const ties = findTies(entries, notes);
    if (ties.length > 0) {
      const lines = ties.map(({ score, entries: group }) => {
        const list = group.map((n) => `#${n}`).join(', ');
        return score === 0
          ? `  • Entries ${list} — not yet scored (0/100)`
          : `  • Entries ${list} — tied at ${displayScore(score)}/100`;
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
          <img src="/mothership.jpeg" alt="Mothership Meltdown" className="top-header-image" />
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
          <img src="/mothership.jpeg" alt="Mothership Meltdown" className="top-header-image" />
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
          <img src="/mothership.jpeg" alt="Mothership Meltdown" className="top-header-image" />
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
      lastSavedAt={lastSavedAt}
    />
  );
}

function ScoringScreen({ judgeName, entries, notes, onNotesUpdate, onSubmit, saveStatus, lastSavedAt }) {
  const [openEntry, setOpenEntry] = useState(null);
  const [sortOrder, setSortOrder] = useState('rank');

  // Tie detection — only flag entries with score > 0
  const tiedScores = (() => {
    const counts = {};
    for (const e of entries) {
      const s = totalScore(notes[e]);
      if (s > 0) counts[s] = (counts[s] || 0) + 1;
    }
    const tied = new Set();
    for (const [s, c] of Object.entries(counts)) {
      if (c > 1) tied.add(Number(s));
    }
    return tied;
  })();

  const sortedEntries = sortOrder === 'rank'
    ? [...entries].sort((a, b) => totalScore(notes[b]) - totalScore(notes[a]))
    : [...entries];

  return (
    <div className="rank-screen">
      <div className="top-header">
        <img src="/mothership.jpeg" alt="Mothership Meltdown" className="top-header-image" />
      </div>

      <header className="rank-header">
        <div>
          <div className="judge-name">{judgeName}</div>
          <div className="save-status">{saveStatusLabel(saveStatus, lastSavedAt)}</div>
        </div>
        <button className="btn-submit" onClick={onSubmit}>
          Submit
        </button>
      </header>

      <div className="sort-toggle">
        <button
          className={`sort-opt${sortOrder === 'rank' ? ' active' : ''}`}
          onClick={() => setSortOrder('rank')}
        >
          Ranking
        </button>
        <button
          className={`sort-opt${sortOrder === 'sequential' ? ' active' : ''}`}
          onClick={() => setSortOrder('sequential')}
        >
          1–50 Order
        </button>
      </div>

      <p className="muted small">
        Tap an entry to score it. Rankings update automatically.
      </p>

      <ul className={`rank-list${sortOrder === 'sequential' ? ' no-medals' : ''}`}>
        {sortedEntries.map((entryNum, idx) => (
          <EntryRow
            key={entryNum}
            id={entryNum}
            position={idx + 1}
            hasNotes={hasAnyNote(notes[entryNum])}
            score={totalScore(notes[entryNum])}
            isTied={tiedScores.has(totalScore(notes[entryNum]))}
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

function EntryRow({ id, position, hasNotes, score, isTied, onTap }) {
  const unscored = score === 0;
  return (
    <li className={`rank-item${isTied ? ' tie-warning' : ''}${unscored ? ' unscored' : ''}`}>
      <span className="position">{position}</span>
      <span className="entry-num">Entry #{id}</span>
      <span className="entry-score">{displayScore(score)}/100</span>
      <button className="notes-btn" onClick={onTap} aria-label="Score and add notes">
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
      [key]: { ...(local[key] || {}), [field]: value },
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

  const PLACEMENT_OPTIONS = [
    { value: 'mids',    label: 'Mids',    className: 'placement-mids' },
    { value: 'average', label: 'Average', className: 'placement-average' },
    { value: 'fire',    label: 'Fire 🔥',  className: 'placement-fire' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Entry #{entryNum}</h2>
          <div className="modal-header-right">
            <span className="modal-total">{displayScore(runningTotal)} / 100</span>
            <button className="close-btn" onClick={onClose} aria-label="Close">×</button>
          </div>
        </header>

        <div className="modal-body">
          {CATEGORIES.map((cat) => (
            <div key={cat.key} className="category-block">
              <div className="cat-header">
                <label className="cat-label">{cat.label}</label>
                <ScoreInput
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
                  className={`placement-btn ${opt.className}${local.placement === opt.value ? ' selected' : ''}`}
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

function ScoreInput({ value, max, onChange }) {
  const [draft, setDraft] = useState(value === 0 ? '' : String(value));

  const commit = (raw) => {
    if (raw === '' || raw == null) {
      onChange(0);
      setDraft('');
      return;
    }
    const num = parseFloat(raw);
    if (isNaN(num)) {
      setDraft(value === 0 ? '' : String(value));
      return;
    }
    const rounded = roundHalf(Math.min(max, Math.max(0, num)));
    onChange(rounded);
    setDraft(rounded === 0 ? '' : String(rounded));
  };

  return (
    <div className="score-input-row">
      <input
        className="score-input"
        type="number"
        min="0"
        max={max}
        step="0.5"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        placeholder="–"
        inputMode="decimal"
      />
      <span className="score-max">/ {max}</span>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function localKey(eventCode, judgeCode) {
  return `mm26_${eventCode}_${judgeCode}`;
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

function hasAnyNote(entryNotes) {
  if (!entryNotes) return false;
  if (entryNotes.placement) return true;
  if (entryNotes.overall_notes && entryNotes.overall_notes.trim().length > 0) return true;
  return CATEGORIES.some((cat) => {
    const v = entryNotes[cat.key];
    return v && ((typeof v.score === 'number' && v.score > 0) || (v.text && v.text.trim().length > 0));
  });
}

function timeAgo(date) {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  return 'a while ago';
}

function saveStatusLabel(status, lastSavedAt) {
  switch (status) {
    case 'saving': return 'Saving…';
    case 'error':  return 'Save failed — retrying…';
    case 'saved':  return `Saved ${timeAgo(lastSavedAt)}`;
    default:       return '';
  }
}
