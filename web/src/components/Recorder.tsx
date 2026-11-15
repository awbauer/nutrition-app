import { toast } from '../toast';
import { Mic, Square } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';

const MAX_SECONDS = 60;

/** Pick a container the browser can record; iOS Safari records audio/mp4 (AAC). */
function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t));
}

type State = 'idle' | 'recording' | 'done' | 'error';

/**
 * Tap to record, tap to stop. Uses MediaRecorder (works in standalone PWAs; no Web Speech API).
 * Calls onClip with the recorded blob.
 */
export function Recorder(props: { onClip: (clip: Blob | null) => void }) {
  const [state, setState] = useState<State>('idle');
  const [seconds, setSeconds] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const stopTracks = () => rec.current?.stream.getTracks().forEach((t) => t.stop());
  useEffect(
    () => () => {
      clearInterval(timer.current);
      if (rec.current?.state === 'recording') rec.current.stop();
      stopTracks();
    },
    [],
  );

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('error');
      toast.error('Recording is not supported in this browser.');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setState('error');
      toast.error('Microphone access was denied. Allow it in Settings → Safari (or the app) → Microphone.', { sticky: true });
      return;
    }
    const mime = pickMime();
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    r.onstop = () => {
      clearInterval(timer.current);
      stopTracks();
      const blob = new Blob(chunks, { type: (r.mimeType || mime || 'audio/mp4').split(';')[0] });
      if (url) URL.revokeObjectURL(url);
      setUrl(URL.createObjectURL(blob));
      setState('done');
      props.onClip(blob);
    };
    rec.current = r;
    r.start();
    setSeconds(0);
    setState('recording');
    props.onClip(null);
    const started = Date.now();
    timer.current = window.setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) r.stop();
    }, 250);
  }

  const stop = () => rec.current?.state === 'recording' && rec.current.stop();

  return (
    <div class="flex flex-col items-center gap-3 py-2">
      <button
        class={`relative flex h-24 w-24 items-center justify-center rounded-full text-white shadow-lg transition active:scale-95 ${state === 'recording' ? 'bg-berry' : 'bg-accent'}`}
        onClick={state === 'recording' ? stop : start}
        aria-label={state === 'recording' ? 'Stop recording' : 'Start recording'}
      >
        {state === 'recording' && <span class="absolute inset-0 animate-ping rounded-full bg-berry/40" aria-hidden="true" />}
        {state === 'recording' ? <Square size={30} fill="currentColor" /> : <Mic size={36} />}
      </button>
      <p class="num text-2xl" aria-live="polite">
        {state === 'recording' ? `0:${String(seconds).padStart(2, '0')}` : ''}
      </p>
      <p class="text-center text-sm text-ink-2">
        {state === 'recording' ? 'Listening… tap to finish' : state === 'done' ? 'Got it.' : 'Tap and say what you ate, like you would to a friend.'}
      </p>
    </div>
  );
}
