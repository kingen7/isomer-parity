// Bidirectional golden corpus: half the cases must come out EQUAL,
// half must come out SEMANTIC. A ruleset tuned only on the first half
// degenerates into ignore-everything; that is the failure this file exists
// to make impossible to ship.

export const ruleset = {
  version: 1,
  rules: [
    { pointer: '/items/*/id', op: 'uuid' },
    { pointer: '/orderId', op: 'uuid' },
    { pointer: '/createdAt', op: 'instant', params: { tolerance: '2s' } },
    { pointer: '/updatedAt', op: 'instant', params: { tolerance: '2s' } },
    { pointer: '/items', op: 'unordered', params: { sortKey: '/sku' } },
    { pointer: '/total', op: 'decimal', params: { scale: 2 } },
    { pointer: '/serverNode', op: 'drop' },
    { match: { method: 'POST', path: '/api/sessions' }, pointer: '/token', op: 'opaque' },
    { pointer: '/items/*/price', op: 'float', params: { digits: 2 } },
    { pointer: '/note', op: 'nil-if-empty' },
    { pointer: '/amount', op: 'decimal', params: { scale: 2 } },
  ],
};

const base = {
  orderId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:01.000Z',
  serverNode: 'web-7',
  note: null,
  total: '120.00',
  status: 'paid',
  customer: { email: 'a@example.com', vip: true },
  items: [
    { sku: 'A-1', qty: 2, price: 10.5, id: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed' },
    { sku: 'B-2', qty: 1, price: 9.0, id: '2b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bee' },
  ],
};

const clone = (patch = {}) => structuredClone({ ...base, ...patch });

export const cases = [
  // ---------- must grade as noise-free ----------
  {
    name: 'byte-identical responses',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: { status: 200, body: clone() },
    expect: 'equal',
  },
  {
    name: 'uuid regenerated, same semantic order',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: { status: 200, body: { ...base, orderId: '9a1fad5b-d9cb-469f-a165-70867728950f' } },
    expect: 'normalized-mismatch',
  },
  {
    name: 'clock skew 1.2s inside tolerance',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: { status: 200, body: clone({ createdAt: '2026-11-20T10:00:01.200Z' }) },
    expect: 'normalized-mismatch',
  },
  {
    name: 'clock skew 3.4s outside tolerance',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: { status: 200, body: clone({ createdAt: '2026-11-20T10:00:03.400Z' }) },
    expect: 'semantic-mismatch',
  },
  {
    name: 'item order unstable, same set',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: {
      status: 200,
      body: clone({ items: [structuredClone(base.items[1]), structuredClone(base.items[0])] }),
    },
    expect: 'normalized-mismatch',
  },
  {
    name: 'empty string and null are the same absence',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: { status: 200, body: clone({ note: '' }) },
    expect: 'normalized-mismatch',
  },
  {
    name: 'float noise inside two digits',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: {
      status: 200,
      body: clone({ items: [{ ...base.items[0], price: 10.500001 }, structuredClone(base.items[1])] }),
    },
    expect: 'normalized-mismatch',
  },
  {
    name: 'volatile server field dropped',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: { status: 200, body: clone({ serverNode: 'web-19' }) },
    expect: 'normalized-mismatch',
  },
  {
    name: 'session token rotated',
    request: { method: 'POST', path: '/api/sessions' },
    legacy: { status: 200, body: { token: 'eyJhbGciOi.legacy.sig', user: 'u-1' } },
    shadow: { status: 200, body: { token: 'eyJhbGciOi.shadow.sig', user: 'u-1' } },
    expect: 'normalized-mismatch',
  },

  // ---------- must grade as semantic: these look like noise, they are not ----------
  {
    name: 'an item silently disappeared from page 2',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: { status: 200, body: clone({ items: [structuredClone(base.items[0])] }) },
    expect: 'semantic-mismatch',
  },
  {
    name: 'rounding changed 10.50 -> 10.49',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: {
      status: 200,
      body: clone({ items: [{ ...base.items[0], price: 10.49 }, structuredClone(base.items[1])] }),
    },
    expect: 'semantic-mismatch',
  },
  {
    name: 'tiebreaker reordered, but the set differs',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: {
      status: 200,
      body: clone({
        items: [structuredClone(base.items[0]), { ...base.items[1], sku: 'B-3' }],
      }),
    },
    expect: 'semantic-mismatch',
  },
  {
    name: 'unrelated business field changed',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: { status: 200, body: clone({ status: 'refunded' }) },
    expect: 'semantic-mismatch',
  },
  {
    name: 'customer email lost a character',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: clone() },
    shadow: { status: 200, body: clone({ customer: { email: 'a@exampl.com', vip: true } }) },
    expect: 'semantic-mismatch',
  },
  {
    name: 'token differs and no rule covers this path',
    request: { method: 'GET', path: '/api/orders' },
    legacy: { status: 200, body: { token: 'aaa', user: 'u-1' } },
    shadow: { status: 200, body: { token: 'bbb', user: 'u-1' } },
    expect: 'semantic-mismatch',
  },
];