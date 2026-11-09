const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { setup, turn } = require('./helpers/app.cjs');
const source = fs.readFileSync(require.resolve('../frontend/engine.js'), 'utf8');
function engineFixture(extra = {}) {
  const context = vm.createContext({ Blob, Response, URLSearchParams, AbortController, DOMException, setTimeout, clearTimeout, ...extra });
  vm.runInContext(source, context); return { context, engine: context.GVEngine, search: context.GVEngine.mapSearch };
}
const plain = value => JSON.parse(JSON.stringify(value));
const event = key => ({ key, preventDefault() {}, stopPropagation() {} });
const idle = engine => { assert.equal(engine.operations.diagnostics().active.length, 0); assert.equal(engine.operations.diagnostics().requests, 0); };
test('coordinates accept decimal, labelled, hemisphere and unambiguous longitude-first pairs locally', () => {
  const { search } = engineFixture();
  for (const input of ['25.25, 55.36', '25.25 55.36', 'lat:25.25; lon:55.36', 'longitude=55.36 latitude=25.25', '25.25 N, 55.36 E'])
    assert.deepEqual(plain(search.parseCoordinates(input)), { lat: 25.25, lon: 55.36, label: '25.250000, 55.360000' });
  assert.equal(search.parseCoordinates('114.33005, 9.88544').lat, 9.88544);
  assert.equal(search.parseCoordinates('25.25, 55.36').lat, 25.25, 'Ambiguous decimal pairs use the displayed latitude-first convention');
  assert.equal(search.parseCoordinates('0, 0').lat, 0); assert.equal(search.parseCoordinates('25 S, 55 W').lon, -55);
  assert.equal(search.parseCoordinates('−25.25; 55.36').lat, -25.25); assert.equal(search.parseCoordinates('Dubai'), null); assert.equal(search.parseCoordinates('90210'), null);
});
test('invalid and unsupported coordinates produce useful errors instead of remote searches', () => {
  const { search } = engineFixture();
  for (const text of ['lat:91 lon:40', '25, 181', '25,55,10', 'NaN lat:20 lon:30', '86, 20']) {
    if (text.startsWith('NaN')) assert.equal(search.parseCoordinates(text), null);
    else assert.throws(() => search.parseCoordinates(text), /coordinates|latitude|imagery/);
  }
});
test('Esri suggestions and place resolution encode input, limit results and request transient WGS84 output', async () => {
  const calls = [], { search, engine } = engineFixture({ fetch: async url => {
    calls.push(new URL(url)); return new Response(JSON.stringify(url.includes('/suggest?') ? { suggestions: [{ text: 'Dubai & coast', magicKey: 'key=1&x' }] }
      : { candidates: [{ address: 'Dubai', location: { x: 55.3, y: 25.2 }, extent: { xmin: 55, ymin: 25, xmax: 56, ymax: 26 } }] }));
  } });
  const suggestions = await search.suggest('Dubai & coast', { center: { lng: 55, lat: 25 } }); assert.equal(suggestions.length, 1);
  const point = await search.find(suggestions[0].label, { magicKey: suggestions[0].magicKey }); assert.equal(point.lat, 25.2); assert.deepEqual(plain(point.bounds), [[25, 55], [26, 56]]);
  assert.equal(calls[0].searchParams.get('text'), 'Dubai & coast'); assert.equal(calls[0].searchParams.get('location'), '55,25'); assert.equal(calls[0].searchParams.get('maxSuggestions'), '5');
  assert.equal(calls[1].searchParams.get('magicKey'), 'key=1&x'); assert.equal(calls[1].searchParams.get('outSR'), '4326'); assert.equal(calls[1].searchParams.get('forStorage'), 'false'); idle(engine);
});
test('empty, malformed and provider-error responses cannot silently produce a map target', async () => {
  const f = engineFixture();
  for (const payload of [{ error: { code: 499 } }, {}, { candidates: [{ address: 'Bad', location: { x: 999, y: 25 } }] }]) {
    f.context.fetch = async () => new Response(JSON.stringify(payload)); await assert.rejects(f.search.find('Dubai'));
  }
  f.context.fetch = async () => new Response(JSON.stringify({ candidates: [] })); assert.equal(await f.search.find('nowhere'), null);
  f.context.fetch = async () => new Response(JSON.stringify({ suggestions: [{ text: 'Bad', magicKey: null }] })); await assert.rejects(f.search.suggest('Dubai')); idle(f.engine);
});
test('pre-aborted searches do not fetch or request location permission', async () => {
  let calls = 0; const { search, engine } = engineFixture({ fetch: async () => { calls++; }, navigator: { geolocation: { watchPosition() { calls++; } } } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(search.suggest('Dubai', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(search.currentLocation({ signal: controller.signal }), { name: 'AbortError' }); assert.equal(calls, 0); idle(engine);
});
test('current location clears its watch on success, cancellation, timeout and permission denial; retry works', async () => {
  let success, error, sequence = 0; const closed = [], f = engineFixture({ navigator: { geolocation: {
    watchPosition(ok, fail) { success = ok; error = fail; return ++sequence; }, clearWatch(id) { closed.push(id); },
  } } });
  let pending = f.search.currentLocation(); success({ coords: { latitude: 25.2, longitude: 55.3 } }); assert.equal((await pending).lon, 55.3);
  const controller = new AbortController(); pending = f.search.currentLocation({ signal: controller.signal }); const late = success; controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); late({ coords: { latitude: 0, longitude: 0 } });
  pending = f.search.currentLocation({ timeoutMs: 5 }); await assert.rejects(pending, { name: 'TimeoutError' });
  pending = f.search.currentLocation(); error({ code: 1 }); await assert.rejects(pending, /permission was denied/);
  pending = f.search.currentLocation(); success({ coords: { latitude: 1, longitude: 2 } }); await pending;
  assert.deepEqual(closed, [1, 2, 3, 4, 5]); idle(f.engine);
});
test('unsupported location and synchronous callbacks leave no operation or watch owner', async () => {
  const f = engineFixture(); await assert.rejects(f.search.currentLocation(), /unavailable/); idle(f.engine);
  let closed = 0; f.context.navigator = { geolocation: { watchPosition(ok) { ok({ coords: { latitude: 0, longitude: 0 } }); return 0; }, clearWatch(id) { assert.equal(id, 0); closed++; } } };
  await f.search.currentLocation(); assert.equal(closed, 1); idle(f.engine);
});
test('focusing the field shows Use current location without starting requests or geolocation', async () => {
  const app = await setup(), before = app.requests.length; let locations = 0;
  app.context.GVEngine.mapSearch.currentLocation = async () => { locations++; };
  app.element('#mapSearchInput').onfocus(); assert.equal(app.element('#mapSearchPopup').hidden, false);
  assert.match(app.element('#mapSearchOptions').innerHTML, /Use current location/); assert.equal(app.requests.length, before); assert.equal(locations, 0);
  app.element('#mapSearchInput').onkeydown(event('Escape')); assert.equal(app.element('#mapSearchPopup').hidden, true);
});
test('coordinate navigation preserves viewed imagery, AOI processing choices, selected detections and edits', async () => {
  const app = await setup(); await app.openClip(); app.groups[2].getLayers()[0].fire('click');
  const before = app.context.GVApp.diagnostics(), date = app.element('#hudRel').textContent, run = app.element('#runN').textContent, requests = app.requests.length;
  const input = app.element('#mapSearchInput'); input.value = '25.25, 55.36'; input.oninput(); await app.element('#mapSearchForm').onsubmit(event('Enter'));
  assert.deepEqual(app.map.position, [25.25, 55.36]); assert.equal(app.map.getZoom(), 16); assert.equal(app.context.GVApp.diagnostics().views.selected, before.views.selected);
  assert.equal(app.element('#hudRel').textContent, date); assert.equal(app.element('#runN').textContent, run); assert.equal(app.requests.length, requests);
  assert.equal(app.allLayers.at(-1).options.interactive, false); assert.equal(app.element('#mapSearchPopup').hidden, true);
});
test('typing debounces suggestions; aborted late suggestions cannot replace a newer coordinate or cleared query', async () => {
  const app = await setup(), input = app.element('#mapSearchInput'); let finish, signal;
  app.context.GVEngine.mapSearch.suggest = async (text, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  input.value = 'Dubai'; input.oninput(); assert.equal(finish, undefined);
  [...app.timers.values()].find(timer => timer.ms === 350).callback(); await turn();
  input.value = '25, 55'; input.oninput(); assert.equal(signal.aborted, true); finish([{ label: 'Obsolete', magicKey: 'old' }]); await turn();
  assert.doesNotMatch(app.element('#mapSearchOptions').innerHTML, /Obsolete/); assert.match(app.element('#mapSearchOptions').innerHTML, /25.000000/);
  app.element('#mapSearchClear').onclick(); assert.equal(input.value, ''); assert.match(app.element('#mapSearchOptions').innerHTML, /Use current location/); idle(app.context.GVEngine);
});
test('suggestion labels are escaped; selecting one resolves its identity and uses its extent', async () => {
  const app = await setup(), input = app.element('#mapSearchInput');
  app.context.GVEngine.mapSearch.suggest = async () => [{ label: '<img src=x onerror=alert(1)>', magicKey: 'exact' }];
  app.context.GVEngine.mapSearch.find = async (text, options) => { assert.equal(options.magicKey, 'exact'); return { lat: 25, lon: 55, label: 'Resolved', bounds: [[24, 54], [26, 56]] }; };
  input.value = 'Dubai'; input.oninput(); [...app.timers.values()].find(timer => timer.ms === 350).callback(); await turn();
  assert.ok(app.element('#mapSearchOptions').innerHTML.includes('&lt;img')); assert.equal(app.element('#mapSearchOptions').innerHTML.includes('<img'), false);
  const before = app.snapshot().fits; await app.element('#mapSearchOptions').querySelectorAll('[data-place-index]')[1].onclick();
  assert.equal(app.snapshot().fits, before + 1); assert.equal(input.value, 'Resolved'); idle(app.context.GVEngine);
});
test('keyboard choices and page hide cancel current-location work without late map movement', async () => {
  const app = await setup(), input = app.element('#mapSearchInput'); let finish, signal;
  app.context.GVEngine.mapSearch.currentLocation = async options => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  input.onfocus(); input.onkeydown(event('ArrowDown')); const pending = app.element('#mapSearchForm').onsubmit(event('Enter')); await turn();
  const position = app.map.position.slice(); app.events.get('pagehide')(); assert.equal(signal.aborted, true);
  finish({ lat: 1, lon: 2, label: 'Late' }); await pending; assert.deepEqual(app.map.position, position); idle(app.context.GVEngine);
});
test('ArrowUp starts at the last option and IME input waits for composition to finish', async () => {
  const app=await setup(),input=app.element('#mapSearchInput');input.value='25,55';input.oninput();input.onkeydown(event('ArrowUp'));
  assert.equal(input.attributes['aria-activedescendant'],'map-place-1');await app.element('#mapSearchForm').onsubmit(event('Enter'));assert.deepEqual(app.map.position,[25,55]);
  input.value='東京';input.oninput({isComposing:true});assert.equal([...app.timers.values()].some(timer=>timer.ms===350),false);
  input.value='東京駅';input.oncompositionend();assert.equal([...app.timers.values()].filter(timer=>timer.ms===350).length,1);app.events.get('pagehide')();
});
