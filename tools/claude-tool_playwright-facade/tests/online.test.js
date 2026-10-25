// Tests on public web pages. A test is skipped when its site is not reachable.
// Set PLAYWRIGHT_FACADE_OFFLINE=1 to skip all of them.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { call, evaluate, ref, startFacadeClient } from './helpers.js';

const SITES = {
  example: 'https://example.com/',
  httpbin: 'https://httpbin.org/forms/post',
  wikipedia: 'https://en.wikipedia.org/wiki/Main_Page',
};

async function reachable(url) {
  if (process.env.PLAYWRIGHT_FACADE_OFFLINE === '1') return false;
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

const online = Object.fromEntries(await Promise.all(
  Object.entries(SITES).map(async ([name, url]) => [name, await reachable(url)]),
));
const skip = (name) => (online[name] ? false : `${SITES[name]} is not reachable`);

describe('public pages', { skip: !Object.values(online).some(Boolean) && 'no site is reachable' }, () => {
  let facade;
  let client;

  before(async () => {
    facade = await startFacadeClient({ name: 'online' });
    client = facade.client;
  });

  after(async () => {
    await facade?.close();
  });

  test('example.com: reads the page and follows the link', { skip: skip('example') }, async () => {
    const text = await call(client, 'browser_navigate', { url: SITES.example });
    assert.match(text, /Page Title: Example Domain/);
    const snapshot = await call(client, 'browser_snapshot');
    assert.match(snapshot, /documentation examples/);
    const link = snapshot.match(/- link "([^"]+)"[^\n]*\[ref=(\w+)\]/);
    assert.ok(link, 'no link on the page');
    await call(client, 'browser_click', { target: link[2], element: link[1] });
    assert.notEqual(await evaluate(client, '() => location.hostname'), 'example.com');
  });

  test('httpbin.org: fills and submits the order form', { skip: skip('httpbin') }, async () => {
    await call(client, 'browser_navigate', { url: SITES.httpbin });
    const snapshot = await call(client, 'browser_snapshot');
    await call(client, 'browser_fill_form', {
      fields: [
        { name: 'Customer name', type: 'textbox', target: ref(snapshot, 'textbox', 'Customer name:'), value: 'Jan Kowalski' },
        { name: 'Telephone', type: 'textbox', target: ref(snapshot, 'textbox', 'Telephone:'), value: '+48 123 456 789' },
        { name: 'E-mail', type: 'textbox', target: ref(snapshot, 'textbox', 'E-mail address:'), value: 'jan@example.com' },
        { name: 'Large', type: 'radio', target: ref(snapshot, 'radio', 'Large'), value: 'true' },
        { name: 'Bacon', type: 'checkbox', target: ref(snapshot, 'checkbox', 'Bacon'), value: 'true' },
        { name: 'Mushroom', type: 'checkbox', target: ref(snapshot, 'checkbox', 'Mushroom'), value: 'true' },
        { name: 'Instructions', type: 'textbox', target: ref(snapshot, 'textbox', 'Delivery instructions:'), value: 'Ring twice' },
      ],
    });
    await call(client, 'browser_click', { target: ref(snapshot, 'button', 'Submit order'), element: 'Submit order' });
    await call(client, 'browser_wait_for', { text: 'custname' });

    const response = await evaluate(client, '() => JSON.parse(document.body.innerText)');
    assert.deepEqual(response.form, {
      custname: 'Jan Kowalski',
      custtel: '+48 123 456 789',
      custemail: 'jan@example.com',
      size: 'large',
      topping: ['bacon', 'mushroom'],
      delivery: '',
      comments: 'Ring twice',
    });
  });

  test('wikipedia.org: searches with a typed query', { skip: skip('wikipedia') }, async () => {
    await call(client, 'browser_navigate', { url: SITES.wikipedia });
    // The search field is the same on each skin of Wikipedia: <input name="search">.
    await call(client, 'browser_type', { target: 'input[name="search"] >> visible=true', element: 'Search field', text: 'Playwright (software)', submit: true });
    await call(client, 'browser_wait_for', { text: 'Microsoft' });
    assert.match(await evaluate(client, '() => document.title'), /Playwright/);
  });
});
