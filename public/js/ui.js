/** Small rendering helpers shared by the views. */
import { ApiError } from './api.js';

/**
 * Escapes anything interpolated into HTML.
 *
 * Product names and review comments are seller and customer input, so nothing
 * user-supplied reaches innerHTML unescaped.
 */
export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );
}

export const money = (amount) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    Number(amount) || 0
  );

export const date = (value) => (value ? new Date(value).toLocaleString() : '—');

export function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  document.getElementById('toasts').append(node);

  setTimeout(() => node.remove(), kind === 'bad' ? 7000 : 3500);
}

/**
 * Reports a failure using the server's own message, and its field details when
 * it sent them — the point of the harness is to see exactly what the API said.
 */
export function reportError(error) {
  if (error instanceof ApiError) {
    const detail = error.fieldSummary;
    toast(detail ? `${error.message}\n${detail}` : `${error.message} (${error.status})`, 'bad');
    return;
  }

  toast(error?.message ?? 'Something went wrong', 'bad');
}

/** Wraps a click handler so failures surface as a toast instead of vanishing. */
export function guard(handler) {
  return async (event) => {
    const button = event.currentTarget;
    const wasDisabled = button.disabled;
    button.disabled = true;

    try {
      await handler(event);
    } catch (error) {
      reportError(error);
    } finally {
      button.disabled = wasDisabled;
    }
  };
}

/** Builds an element tree from HTML and wires `[data-on-click]` handlers. */
export function html(markup) {
  const template = document.createElement('template');
  template.innerHTML = markup.trim();
  return template.content;
}

export function statusTag(status) {
  const kind =
    {
      PENDING: 'warn',
      PAID: 'ok',
      PROCESSING: 'warn',
      SHIPPED: 'warn',
      DELIVERED: 'ok',
      CANCELLED: 'bad',
      PAYMENT_FAILED: 'bad',
      RETURNED: 'bad',
      REFUNDED: 'bad',
      SUCCESS: 'ok',
      FAILED: 'bad',
      INITIATED: 'warn',
    }[status] ?? '';

  return `<span class="tag ${kind}">${esc(status)}</span>`;
}

export function panel(title, hint, body) {
  return `
    <section class="panel">
      <h2>${esc(title)}</h2>
      ${hint ? `<p class="hint">${hint}</p>` : ''}
      ${body}
    </section>`;
}

export function empty(message) {
  return `<div class="empty">${esc(message)}</div>`;
}

/** Renders a raw response so the underlying JSON is always inspectable. */
export function rawJson(label, value) {
  return `
    <details>
      <summary>${esc(label)}</summary>
      <pre>${esc(JSON.stringify(value, null, 2))}</pre>
    </details>`;
}

/** Reads a form into a plain object, dropping blank optional fields. */
export function formValues(form) {
  const values = {};

  for (const [key, value] of new FormData(form).entries()) {
    if (value === '') continue;
    values[key] = value;
  }

  return values;
}
