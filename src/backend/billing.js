// Paddle Billing checkout (overlay).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { CONFIG } from '../config.js';

let ready = null;
function loadPaddle() {
  return (ready ||= new Promise((resolve, reject) => {
    if (window.Paddle) return resolve(window.Paddle);
    const s = document.createElement('script');
    s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
    s.onload = () => resolve(window.Paddle);
    s.onerror = () => { ready = null; reject(new Error('Could not load the checkout')); };
    document.head.append(s);
  }).then((Paddle) => {
    if (CONFIG.paddleEnvironment === 'sandbox') Paddle.Environment.set('sandbox');
    Paddle.Initialize({ token: CONFIG.paddleClientToken, eventCallback: (e) => listeners.forEach((f) => f(e)) });
    return Paddle;
  }));
}
const listeners = new Set();

export const billingConfigured = () => !!CONFIG.paddleClientToken;

// Opens checkout for a price; resolves true when payment completes.
export async function checkout(priceKey, user) {
  const priceId = CONFIG.prices[priceKey];
  if (!priceId) throw new Error('This product is not on sale yet');
  const Paddle = await loadPaddle();
  return new Promise((resolve) => {
    const on = (e) => {
      if (e.name === 'checkout.completed') { listeners.delete(on); resolve(true); }
      if (e.name === 'checkout.closed') { listeners.delete(on); resolve(false); }
    };
    listeners.add(on);
    Paddle.Checkout.open({
      items: [{ priceId, quantity: 1 }],
      customer: user?.email ? { email: user.email } : undefined,
      customData: { product: 'photography.work', ...(user?.id ? { user_id: user.id } : {}) },
      settings: { displayMode: 'overlay', theme: matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark', allowLogout: !user },
    });
  });
}
