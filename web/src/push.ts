import { api } from './api';

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64url: string): Uint8Array {
  const b = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask for permission (must run from a tap), subscribe, and register with the Worker. */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('This browser does not support notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed. You can change this in iOS Settings → Notifications.');
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register('/sw.js'));
  await navigator.serviceWorker.ready;
  const { publicKey } = await api.get<{ publicKey: string }>('/push/key');
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource }));
  await api.post('/push/subscribe', sub.toJSON());
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await fetch('/api/push/subscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
  await sub.unsubscribe();
}
