import { api, auth, getUser } from '../api.js';
import { esc, formValues, guard, panel, rawJson, toast } from '../ui.js';

/** The seeded accounts, so the harness is usable the moment `npm run seed` runs. */
const SEEDED = [
  { email: 'admin@shopcore.dev', role: 'admin' },
  { email: 'seller@shopcore.dev', role: 'seller' },
  { email: 'customer@shopcore.dev', role: 'customer' },
];

export function render(root, { refresh }) {
  const user = getUser();

  root.innerHTML = user ? signedIn(user) : signedOut();

  if (!user) {
    root.querySelector('#login-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const { email, password } = formValues(event.target);

      guard(async () => {
        await auth.login(email, password);
        toast(`Signed in as ${email}`, 'ok');
        refresh();
      })({ currentTarget: event.target.querySelector('button') });
    });

    root.querySelector('#register-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const values = formValues(event.target);

      guard(async () => {
        await auth.register(values);
        toast('Account created and signed in', 'ok');
        refresh();
      })({ currentTarget: event.target.querySelector('button') });
    });

    for (const button of root.querySelectorAll('[data-seed-email]')) {
      button.addEventListener(
        'click',
        guard(async (event) => {
          const email = event.currentTarget.dataset.seedEmail;
          await auth.login(email, 'Password123');
          toast(`Signed in as ${email}`, 'ok');
          refresh();
        })
      );
    }
    return;
  }

  root.querySelector('#address-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(event.target);

    guard(async () => {
      await api.post('/users/me/addresses', values);
      toast('Address added', 'ok');
      refresh();
    })({ currentTarget: event.target.querySelector('button') });
  });

  root.querySelector('#profile-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const values = formValues(event.target);

    guard(async () => {
      await api.patch('/users/me', values);
      toast('Profile updated. Changing your email resets verification.', 'ok');
      refresh();
    })({ currentTarget: event.target.querySelector('button') });
  });

  for (const button of root.querySelectorAll('[data-remove-address]')) {
    button.addEventListener(
      'click',
      guard(async (event) => {
        await api.delete(`/users/me/addresses/${event.currentTarget.dataset.removeAddress}`);
        toast('Address removed', 'ok');
        refresh();
      })
    );
  }
}

function signedOut() {
  return [
    panel(
      'Sign in',
      'Seeded accounts all use the password <code>Password123</code>. Run <code>npm run seed</code> if they do not exist yet.',
      `
      <form id="login-form" class="row">
        <label>Email <input name="email" type="email" value="customer@shopcore.dev" required /></label>
        <label>Password <input name="password" type="password" value="Password123" required /></label>
        <button class="action" type="submit">Sign in</button>
      </form>
      <div class="row" style="margin-top:12px">
        ${SEEDED.map(
          (account) =>
            `<button class="action secondary" data-seed-email="${esc(account.email)}">as ${esc(account.role)}</button>`
        ).join('')}
      </div>`
    ),
    panel(
      'Register',
      'Only <code>customer</code> and <code>seller</code> can be self-assigned — the API rejects <code>admin</code> here.',
      `
      <form id="register-form" class="row">
        <label>Name <input name="name" required minlength="2" /></label>
        <label>Email <input name="email" type="email" required /></label>
        <label>Password <input name="password" type="password" required placeholder="Str0ngPassw0rd" /></label>
        <label>Role
          <select name="role">
            <option value="customer">customer</option>
            <option value="seller">seller</option>
            <option value="admin">admin (should fail)</option>
          </select>
        </label>
        <button class="action" type="submit">Register</button>
      </form>`
    ),
  ].join('');
}

function signedIn(user) {
  const addresses = user.addresses ?? [];

  return [
    panel(
      'Profile',
      `Signed in as <strong>${esc(user.email)}</strong> · role <span class="tag">${esc(user.role)}</span> · email ${
        user.isEmailVerified
          ? '<span class="tag ok">verified</span>'
          : '<span class="tag warn">unverified</span>'
      }`,
      `
      <form id="profile-form" class="row">
        <label>Name <input name="name" value="${esc(user.name)}" /></label>
        <label>Email <input name="email" type="email" value="${esc(user.email)}" /></label>
        <button class="action" type="submit">Update</button>
      </form>
      ${rawJson('Raw /users/me', user)}`
    ),
    panel(
      'Address book',
      'Checkout snapshots the address onto the order, so later edits never rewrite a past order.',
      `
      ${
        addresses.length
          ? `<table>
              <thead><tr><th>Label</th><th>Name</th><th>Address</th><th>Default</th><th></th></tr></thead>
              <tbody>
                ${addresses
                  .map(
                    (address) => `
                  <tr>
                    <td>${esc(address.label)}</td>
                    <td>${esc(address.fullName)}</td>
                    <td>${esc(address.line1)}, ${esc(address.city)}, ${esc(address.postalCode)}, ${esc(address.country)}</td>
                    <td>${address.isDefault ? '<span class="tag ok">default</span>' : ''}</td>
                    <td><button class="action danger" data-remove-address="${esc(address.id ?? address._id)}">Remove</button></td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>`
          : '<div class="empty">No addresses yet. Checkout needs one.</div>'
      }
      <form id="address-form" class="row" style="margin-top:12px">
        <label>Label <input name="label" value="Home" /></label>
        <label>Full name <input name="fullName" value="${esc(user.name)}" required /></label>
        <label>Phone <input name="phone" value="+15550100" required /></label>
        <label>Line 1 <input name="line1" value="1 Test Street" required /></label>
        <label>City <input name="city" value="London" required /></label>
        <label>State <input name="state" value="Greater London" required /></label>
        <label>Postcode <input name="postalCode" value="EC1A 1BB" required /></label>
        <label>Country <input name="country" value="United Kingdom" required /></label>
        <button class="action" type="submit">Add address</button>
      </form>`
    ),
  ].join('');
}
