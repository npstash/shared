// Form filling through the facade, on the local fixture pages.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { call, evaluate, ref, startFacadeClient, startSite } from './helpers.js';

describe('form filling', () => {
  let site;
  let facade;
  let client;

  before(async () => {
    site = await startSite();
    facade = await startFacadeClient({ name: 'forms' });
    client = facade.client;
  });

  after(async () => {
    await facade?.close();
    await site?.close();
  });

  async function open(page) {
    await call(client, 'browser_navigate', { url: `${site.url}/${page}` });
    return call(client, 'browser_snapshot');
  }

  test('browser_type fills text fields found by ref', async () => {
    const snapshot = await open('form.html');
    await call(client, 'browser_type', { target: ref(snapshot, 'textbox', 'Full name'), element: 'Full name', text: 'Jan Kowalski' });
    await call(client, 'browser_type', { target: ref(snapshot, 'textbox', 'Bio'), element: 'Bio', text: 'Line one\nLine two' });

    const values = await evaluate(client, `() => ({
      name: document.getElementById('full-name').value,
      bio: document.getElementById('bio').value,
    })`);
    assert.deepEqual(values, { name: 'Jan Kowalski', bio: 'Line one\nLine two' });
  });

  test('browser_type replaces the value of a field', async () => {
    const snapshot = await open('form.html');
    const name = ref(snapshot, 'textbox', 'Full name');
    await call(client, 'browser_type', { target: name, element: 'Full name', text: 'first' });
    await call(client, 'browser_type', { target: name, element: 'Full name', text: 'second' });
    assert.equal(await evaluate(client, `() => document.getElementById('full-name').value`), 'second');
  });

  test('browser_fill_form fills all field types and the form submits them', async () => {
    const snapshot = await open('form.html');
    await call(client, 'browser_fill_form', {
      fields: [
        { name: 'Full name', type: 'textbox', target: ref(snapshot, 'textbox', 'Full name'), value: 'Anna Nowak' },
        { name: 'Email', type: 'textbox', target: ref(snapshot, 'textbox', 'Email'), value: 'anna@example.com' },
        { name: 'Password', type: 'textbox', target: ref(snapshot, 'textbox', 'Password'), value: 'S3cret-Pa55' },
        { name: 'Age', type: 'textbox', target: ref(snapshot, 'spinbutton', 'Age'), value: '42' },
        { name: 'Birthday', type: 'textbox', target: '#birthday', value: '1984-02-29' },
        { name: 'Bio', type: 'textbox', target: ref(snapshot, 'textbox', 'Bio'), value: 'Zażółć gęślą jaźń' },
        { name: 'Country', type: 'combobox', target: ref(snapshot, 'combobox', 'Country'), value: 'Germany' },
        { name: 'Pro', type: 'radio', target: ref(snapshot, 'radio', 'Pro'), value: 'true' },
        { name: 'Newsletter', type: 'checkbox', target: ref(snapshot, 'checkbox', 'Subscribe to the newsletter'), value: 'true' },
        { name: 'Volume', type: 'slider', target: ref(snapshot, 'slider', 'Volume'), value: '8' },
      ],
    });
    await call(client, 'browser_select_option', {
      target: ref(snapshot, 'listbox', 'Languages'),
      element: 'Languages',
      values: ['en', 'de'],
    });
    await call(client, 'browser_click', { target: ref(snapshot, 'button', 'Register'), element: 'Register' });

    const submitted = await evaluate(client, `() => JSON.parse(document.getElementById('result').textContent)`);
    assert.deepEqual(submitted, {
      fullName: 'Anna Nowak',
      email: 'anna@example.com',
      password: 'S3cret-Pa55',
      age: '42',
      birthday: '1984-02-29',
      bio: 'Zażółć gęślą jaźń',
      country: 'de',
      languages: ['en', 'de'],
      plan: 'pro',
      newsletter: 'yes',
      volume: '8',
    });
  });

  test('browser_fill_form can clear a checkbox', async () => {
    const snapshot = await open('form.html');
    const newsletter = ref(snapshot, 'checkbox', 'Subscribe to the newsletter');
    const field = { name: 'Newsletter', type: 'checkbox', target: newsletter };
    await call(client, 'browser_fill_form', { fields: [{ ...field, value: 'true' }] });
    assert.equal(await evaluate(client, `() => document.getElementById('newsletter').checked`), true);
    await call(client, 'browser_fill_form', { fields: [{ ...field, value: 'false' }] });
    assert.equal(await evaluate(client, `() => document.getElementById('newsletter').checked`), false);
  });

  test('the browser blocks submit of a form with an empty required field', async () => {
    const snapshot = await open('form.html');
    await call(client, 'browser_click', { target: ref(snapshot, 'button', 'Register'), element: 'Register' });
    assert.equal(await evaluate(client, `() => location.pathname`), '/form.html');
  });

  test('browser_type with slowly sends key events', async () => {
    const snapshot = await open('dynamic.html');
    await call(client, 'browser_type', { target: ref(snapshot, 'textbox', 'Search'), element: 'Search', text: 'abc', slowly: true });
    const state = await evaluate(client, `() => [document.getElementById('keys').textContent, document.getElementById('greeting').textContent]`);
    assert.deepEqual(state, ['Keys: 3', 'Hello, abc']);
  });

  test('browser_type with submit presses Enter', async () => {
    const snapshot = await open('dynamic.html');
    await call(client, 'browser_type', { target: ref(snapshot, 'textbox', 'Search'), element: 'Search', text: 'playwright', submit: true });
    assert.equal(await evaluate(client, `() => document.getElementById('submitted').textContent`), 'Searched for: playwright');
  });

  test('a field that the page shows after a click can be filled', async () => {
    let snapshot = await open('dynamic.html');
    assert.doesNotMatch(snapshot, /textbox "Company"/);
    await call(client, 'browser_click', { target: ref(snapshot, 'checkbox', 'I represent a company'), element: 'company checkbox' });
    snapshot = await call(client, 'browser_snapshot');
    await call(client, 'browser_type', { target: ref(snapshot, 'textbox', 'Company'), element: 'Company', text: 'ACME' });
    assert.equal(await evaluate(client, `() => document.getElementById('company').value`), 'ACME');
  });

  test('browser_press_key types into the focused field', async () => {
    const snapshot = await open('dynamic.html');
    await call(client, 'browser_click', { target: ref(snapshot, 'textbox', 'Search'), element: 'Search' });
    await call(client, 'browser_press_key', { key: 'x' });
    await call(client, 'browser_press_key', { key: 'Enter' });
    assert.equal(await evaluate(client, `() => document.getElementById('submitted').textContent`), 'Searched for: x');
  });
});
