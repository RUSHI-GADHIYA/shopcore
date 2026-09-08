/**
 * Entry point: tab routing, session restore, and error reporting.
 *
 * The tabs shown depend on the signed-in role, but that is presentation only —
 * the server enforces the same rules, and hiding a tab is not a permission
 * check. Signing in as a customer and calling an admin route still returns 403.
 */
import { auth, getUser, onAuthChange } from './api.js';
import { reportError, toast } from './ui.js';

import * as account from './views/account.js';
import * as catalog from './views/catalog.js';
import * as cart from './views/cart.js';
import * as orders from './views/orders.js';
import * as seller from './views/seller.js';
import * as admin from './views/admin.js';

const VIEWS = { account, catalog, cart, orders, seller, admin };

const root = document.getElementById('view');
const tabs = document.getElementById('tabs');
const whoami = document.getElementById('whoami');
const signOutButton = document.getElementById('sign-out');

let currentView = 'account';

/** Re-runs the active view. Passed into each view so an action can refresh. */
async function refresh() {
  const view = VIEWS[currentView];

  try {
    await view.render(root, { refresh });
  } catch (error) {
    reportError(error);

    // A 403 usually means the role changed underneath the tab.
    if (error?.status === 401 || error?.status === 403) {
      root.innerHTML = `<div class="empty">${
        error.status === 401 ? 'Session expired — sign in again.' : 'Your role cannot see this.'
      }</div>`;
    }
  }
}

function show(name) {
  currentView = name;

  for (const button of tabs.querySelectorAll('button')) {
    button.setAttribute('aria-selected', String(button.dataset.view === name));
  }

  refresh();
}

/** Shows only the tabs the current role can use, and falls back if one vanishes. */
function applyRoleVisibility(user) {
  for (const button of tabs.querySelectorAll('button')) {
    const requires = button.dataset.requires;

    if (!requires) {
      button.hidden = false;
      continue;
    }

    button.hidden = requires === 'auth' ? !user : !user || !requires.split(',').includes(user.role);
  }

  whoami.innerHTML = user ? `<strong>${user.name}</strong> · ${user.role}` : 'Not signed in';
  signOutButton.hidden = !user;

  // If the active tab just became unavailable, retreat to Account.
  const active = tabs.querySelector(`button[data-view="${currentView}"]`);
  if (active?.hidden) show('account');
}

tabs.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-view]');
  if (button) show(button.dataset.view);
});

signOutButton.addEventListener('click', async () => {
  await auth.logout();
  toast('Signed out');
  show('account');
});

onAuthChange((user) => applyRoleVisibility(user));

// A reload loses the in-memory access token but not the httpOnly refresh
// cookie, so the session is recovered rather than requiring a fresh sign-in.
auth
  .restore()
  .catch(() => null)
  .finally(() => {
    applyRoleVisibility(getUser());
    show(getUser() ? 'catalog' : 'account');
  });
